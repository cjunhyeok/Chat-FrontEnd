import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useDiscussionQueue } from "../hooks/useDiscussionQueue";
import { usePendingInvite } from "../hooks/usePendingInvite";
import { useSpaces } from "../hooks/useSpaces";
import { useWsErrorBanner } from "../hooks/useWsErrorBanner";
import { useWebSocket } from "../socket/useWebSocket";
import { useSpaceActivity } from "../socket/useSpaceActivity";
import { leaveSpace, renameSpace } from "../api/spaceApi";
import { useRoomHistory } from "../hooks/useRoomHistory";
import { useRoomEntry } from "../hooks/useRoomEntry";
import { useReadReceipt } from "../hooks/useReadReceipt";
import SpaceWindow from "../components/chat/SpaceWindow";
import MemberPanel from "../components/chat/MemberPanel";
import DiscussionPanel from "../components/chat/DiscussionPanel";
import CreateSpaceModal from "../components/chat/CreateSpaceModal";
import WorkspaceBackground from "../components/chat/WorkspaceBackground";
import ReconnectBanner from "../components/chat/ReconnectBanner";
import WsErrorBanner from "../components/chat/WsErrorBanner";
import ChatSidebar from "../components/chat/ChatSidebar";

export default function ChatPage() {
  const { auth } = useAuth();

  // UI 상태
  // null | { type: "members" } | { type: "discussion", message }
  const [panelState, setPanelState] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // 데이터 상태 — realtime 연동 (위치 유지)
  const [selectedSpaceId, setSelectedSpaceId] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);

  const { spaces, spacesError, spacesLoaded, selectedSpace, refreshSpaces, applyMessageSummary, removeSpace, patchSpace } =
    useSpaces(selectedSpaceId);
  const { wsError, setWsError } = useWsErrorBanner();

  const {
    incomingDiscussionEvents,
    appendDiscussionEvent,
    consumeDiscussionEvents,
    clearDiscussionEvents,
  } = useDiscussionQueue();

  // refs — realtime 연동 (위치 유지)
  const selectedSpaceIdRef = useRef(null);
  const prevConnectedRef = useRef(false);
  const isInitialConnectRef = useRef(true);
  // handleMessage(useCallback)가 useSpaceActivity보다 먼저 선언되어 notifyEntered를 직접 참조할 수 없으므로 ref로 우회한다
  const notifyEnteredRef = useRef(() => {});
  // handleMessage가 useRoomHistory/useRoomEntry보다 먼저 선언되어 최신 핸들러를 직접 참조할 수 없으므로 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const handleChatMessageRef = useRef(() => {});
  const handleReadEventBatchRef = useRef(() => {});
  const handleChatMessageErrorRef = useRef(() => {});
  const handleDiscussionMessageCountRef = useRef(() => {});
  const clearMessagesRef = useRef(() => {});
  const handleEnterRoomAckRef = useRef(() => {});
  const handleEnterRoomErrorRef = useRef(() => {});
  const clearEnterRoomFailureRef = useRef(() => {});
  const countedDiscussionMessageIdsRef = useRef(new Set());
  // handleMessage(ROOM_MESSAGE_SUMMARY_UPDATED)가 최신 isSpaceActive를 참조하도록 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const isSpaceActiveRef = useRef(() => false);
  // handleMessage가 useReadReceipt보다 먼저 선언되어 최신 함수를 직접 참조할 수 없으므로 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const scheduleReadUpToRef = useRef(() => {});
  const selectApplicableReadEventsRef = useRef(() => []);
  // useSpaceActivity(inactive 전환 직전 콜백)가 useReadReceipt보다 먼저 선언되어 최신 flushPendingRead/discardPendingRead를
  // 직접 참조할 수 없으므로 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const onBeforeInactiveRef = useRef(() => {});

  // WebSocket 수신 메시지 처리
  const handleMessage = useCallback(
    (data) => {
      // READ_EVENT_BATCH 처리: 현재 방 검증 → 유효성 검사/중복 병합/stale 판단(useReadReceipt) →
      // 통과한 read만 한 번의 messages 반영(useRoomHistory)으로 전달한다. reads가 배열이 아니거나 비어 있으면 조용히 무시한다.
      const applyReadEventReads = (chatRoomId, reads) => {
        if (chatRoomId !== selectedSpaceIdRef.current) return;
        if (!Array.isArray(reads) || reads.length === 0) return;

        const applicableReads = selectApplicableReadEventsRef.current(reads);
        if (applicableReads.length === 0) return;

        handleReadEventBatchRef.current(applicableReads);
      };

      switch (data.messageType) {
        case "CHAT_MESSAGE":
          if (data.chatRoomId === selectedSpaceIdRef.current) {
            handleChatMessageRef.current(data);
            scheduleReadUpToRef.current(data.chatRoomId, data.chatId);
          }
          break;

        case "SPACE_TITLE_CHANGED":
          patchSpace(data.chatRoomId, { title: data.title });
          break;

        case "SPACE_INVITED":
          refreshSpaces();
          break;

        case "ROOM_MESSAGE_SUMMARY_UPDATED":
          applyMessageSummary(data, isSpaceActiveRef.current(data.chatRoomId));
          break;

        case "READ_EVENT_BATCH":
          applyReadEventReads(data.chatRoomId, data.reads);
          break;

        case "DISCUSSION_MESSAGE_EVENT":
          if (data.spaceId !== selectedSpaceIdRef.current) break;
          appendDiscussionEvent(data);

          if (
            data.chatId &&
            data.discussionMessageId &&
            !countedDiscussionMessageIdsRef.current.has(data.discussionMessageId)
          ) {
            countedDiscussionMessageIdsRef.current.add(data.discussionMessageId);
            handleDiscussionMessageCountRef.current(data);
          }
          break;

        case "ENTER_ROOM_ACK":
          // 이미 다른 Space로 전환된 뒤 늦게 도착한 stale ACK는 무시한다 (timeout이 없으므로 이 비교가 유일한 매칭 기준이다)
          if (data.chatRoomId !== selectedSpaceIdRef.current) break;

          handleEnterRoomAckRef.current(data.chatRoomId);
          // ENTER_ROOM이 서버에서 active 등록까지 수행하므로, ACK로 확인된 이후에만 active로 간주한다
          notifyEnteredRef.current(data.chatRoomId);
          break;

        case "ERROR": {
          console.warn("WS ERROR", {
            requestType: data.requestType,
            errorCode: data.errorCode,
            chatRoomId: data.chatRoomId,
          });

          // 다른 Space로 전환된 뒤 늦게 도착한 stale ERROR는 무시한다 (errorCode별 처리 내용은 변경 없음)
          const isEnterRoomError =
            data.requestType === "ENTER_ROOM" &&
            data.chatRoomId === selectedSpaceIdRef.current;

          if (data.requestType === "CHAT_MESSAGE" && data.clientMessageId) {
            handleChatMessageErrorRef.current(data.clientMessageId, data.errorCode);
          }

          if (isEnterRoomError) {
            handleEnterRoomErrorRef.current(data.chatRoomId, data.errorCode);
          }

          // INTERNAL_ERROR는 권한/목록 문제가 아니라 서버 내부 처리 실패다 — BE 원문은 "재시도해도 되는지"가 불명확해 FE에서만 문구를 보완한다
          if (isEnterRoomError && data.errorCode === "INTERNAL_ERROR") {
            setWsError("일시적인 오류로 채팅방 입장에 실패했습니다. 다시 시도해주세요.");
          } else if (isEnterRoomError && data.errorCode === "INVALID_REQUEST") {
            setWsError("방에 입장할 수 없습니다. 새로고침 후 다시 시도해주세요.");
          } else if (isEnterRoomError && data.errorCode === "UNAUTHORIZED") {
            // 지금은 안내만 한다 — 자동 로그아웃/페이지 이동은 별도 작업에서 다룬다
            setWsError("로그인이 만료되었습니다. 다시 로그인해주세요.");
          } else {
            setWsError(data.message);
          }

          // 서버는 비참여자도 ROOM_NOT_FOUND로 내려줄 수 있으므로, FE에서는 ROOM_NOT_FOUND/FORBIDDEN을 접근 불가 계열로 취급해
          // Space 목록을 다시 조회하고 실제로 사라졌는지 확인한다 (그 외 errorCode는 공통 처리만 적용)
          if (isEnterRoomError && (data.errorCode === "ROOM_NOT_FOUND" || data.errorCode === "FORBIDDEN")) {
            const erroredSpaceId = data.chatRoomId;

            refreshSpaces().then((refreshedSpaces) => {
              // refresh가 끝나기 전에 다른 Space로 이동했으면 이 결과는 더 이상 유효하지 않다
              if (selectedSpaceIdRef.current !== erroredSpaceId) return;
              // refresh 자체가 실패하면 접근 가능 여부를 판단할 수 없으므로 기존 재시도 UI를 그대로 둔다
              if (refreshedSpaces === null) return;

              const stillAccessible = refreshedSpaces.some((s) => s.chatRoomId === erroredSpaceId);
              if (stillAccessible) return; // 여전히 접근 가능 — enterRoomFailed=true 유지, 재시도 버튼 노출 그대로

              // 목록에서 사라짐 — 더 이상 접근할 수 없는 Space
              setSelectedSpaceId(null);
              clearMessagesRef.current();
              setPanelState(null);
              clearDiscussionEvents();
              clearEnterRoomFailureRef.current();
              setWsError("더 이상 접근할 수 없는 공간입니다.");
            });
          }

          break;
        }

        default:
          break;
      }
    },
    [
      patchSpace,
      applyMessageSummary,
      appendDiscussionEvent,
      setWsError,
      refreshSpaces,
      clearDiscussionEvents,
    ]
  );

  const { connected, reconnecting, sendEnterRoom, sendChatMessage, sendRoomActive, sendRoomInactive, sendReadUpTo, sendDiscussionMessage } = useWebSocket(handleMessage);

  const {
    enteredSpaceId,
    enterRoomFailed,
    enterRoomRetryable,
    retryEnterRoom,
    handleEnterRoomAck,
    handleEnterRoomError,
    clearEnterRoomFailure,
  } = useRoomEntry({ connected, selectedSpaceId, sendEnterRoom });

  // handleMessage가 useRoomEntry보다 먼저 선언되어 최신 핸들러를 직접 참조할 수 없으므로 ref로 동기화한다 (notifyEnteredRef와 동일한 이유)
  useEffect(() => {
    handleEnterRoomAckRef.current = handleEnterRoomAck;
    handleEnterRoomErrorRef.current = handleEnterRoomError;
    clearEnterRoomFailureRef.current = clearEnterRoomFailure;
  });

  // ENTER_ROOM 실패 후 사용자가 명시적으로 재시도할 때만 호출된다. wsError는 useRoomEntry가 모르는 공용 배너라 여기서 함께 비운다.
  const handleRetryEnterRoom = useCallback(() => {
    // 같은 메시지로 다시 실패해도 4초 배너가 온전히 재노출되도록 먼저 비운다 (useWsErrorBanner는 값이 바뀔 때만 타이머를 재시작함)
    setWsError(null);
    retryEnterRoom();
  }, [retryEnterRoom, setWsError]);

  // Space 메시지 전송 가능 여부를 나타내는 connection state
  // offline: 네트워크 끊김 / reconnecting: 소켓 재연결 중 / synchronizing: ENTER_ROOM_ACK 대기 중 / ready: ACK 수신 완료(전송 가능)
  // useRoomHistory(handleRetryMessage)가 필요로 하므로 이 hook 호출보다 앞서 계산해둔다
  const connectionState = useMemo(() => {
    if (!online) return "offline";
    if (!connected) return "reconnecting";
    if (selectedSpaceId !== null && enteredSpaceId !== selectedSpaceId) return "synchronizing";
    return "ready";
  }, [online, connected, selectedSpaceId, enteredSpaceId]);

  const {
    renderMessages,
    lastReadMessageId,
    historyLoading,
    historyError,
    hasMore,
    isLoadingMore,
    loadHistoryForSpace,
    recoverHistoryAfterReconnect,
    handleRetryHistory,
    handleLoadMore,
    handleChatMessage,
    handleChatMessageError,
    handleReadEventBatch,
    handleDiscussionMessageCount,
    handleSend,
    handleRetryMessage,
    handleRemoveFailedMessage,
    clearMessages,
  } = useRoomHistory({ selectedSpaceId, selectedSpaceIdRef, connectionState, sendChatMessage, auth });

  // handleMessage가 useRoomHistory보다 먼저 선언되어 최신 핸들러를 직접 참조할 수 없으므로 ref로 동기화한다 (notifyEnteredRef와 동일한 이유)
  useEffect(() => {
    handleChatMessageRef.current = handleChatMessage;
    handleReadEventBatchRef.current = handleReadEventBatch;
    handleChatMessageErrorRef.current = handleChatMessageError;
    handleDiscussionMessageCountRef.current = handleDiscussionMessageCount;
    clearMessagesRef.current = clearMessages;
  });

  // 세션이 특정 Space에 대해 실제로 inactive → active로 전환된 순간에만 호출된다 (useSpaceActivity 참고).
  // 방 선택 시점의 낙관적 초기화(handleSelectSpace)와는 별개로, 서버 activity 정책과 동일한 시점에 unread를 최종 보정한다.
  const handleSpaceActivated = useCallback(
    (spaceId) => {
      patchSpace(spaceId, { unreadMessageCount: 0 });
    },
    [patchSpace]
  );

  const { notifyEntered, isSpaceActive } = useSpaceActivity({
    selectedSpaceId,
    connected,
    sendRoomActive,
    sendRoomInactive,
    onActivate: handleSpaceActivated,
    onBeforeInactive: (spaceId) => onBeforeInactiveRef.current(spaceId),
  });

  const {
    scheduleReadUpTo,
    flushPendingRead,
    discardPendingRead,
    resetReadReceipt,
    selectApplicableReadEvents,
  } = useReadReceipt({
    sendReadUpTo,
    isSpaceActive,
  });

  // useSpaceActivity(inactive 전환 직전 콜백)가 최신 flushPendingRead/discardPendingRead를 참조하도록 매 렌더마다 동기화한다.
  // blur/hidden은 같은 방을 유지하므로 resetReadReceipt()가 아니라 flush + discard만 수행한다 (memberLastReadRef 보존).
  useEffect(() => {
    onBeforeInactiveRef.current = (spaceId) => {
      flushPendingRead(spaceId);
      discardPendingRead();
    };
  });

  // handleMessage(ENTER_ROOM_ACK)가 최신 notifyEntered를 참조하도록 매 렌더마다 동기화한다
  useEffect(() => {
    notifyEnteredRef.current = notifyEntered;
  });

  // handleMessage(ROOM_MESSAGE_SUMMARY_UPDATED)가 최신 isSpaceActive를 참조하도록 매 렌더마다 동기화한다
  useEffect(() => {
    isSpaceActiveRef.current = isSpaceActive;
  });

  // handleMessage(CHAT_MESSAGE/READ_EVENT_BATCH)가 최신 scheduleReadUpTo/selectApplicableReadEvents를 참조하도록 매 렌더마다 동기화한다
  useEffect(() => {
    scheduleReadUpToRef.current = scheduleReadUpTo;
    selectApplicableReadEventsRef.current = selectApplicableReadEvents;
  });

  // selectedSpaceIdRef를 최신 selectedSpaceId로 동기화 (reconnect effect에서 사용)
  useEffect(() => { selectedSpaceIdRef.current = selectedSpaceId; }, [selectedSpaceId]);

  // 브라우저 online/offline 상태 추적 (connectionState 계산용)
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // 재연결 시 state recovery: WebSocket이 false→true로 바뀌면 상태 재동기화
  // (연결 끊김 자체의 READ 상태 정리는 아래 같은 effect의 else 분기가 담당한다 — prevConnectedRef를 공유해 true→false 전이를 구분한다)
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      if (!isInitialConnectRef.current) {
        refreshSpaces();

        const spaceId = selectedSpaceIdRef.current;
        if (spaceId !== null) {
          // reconnect의 cursor 정합성 복구는 ENTER_ROOM이 아니라 recoverHistoryAfterReconnect(history 재조회)가 담당한다
          // (백엔드 확인 결과 ENTER_ROOM은 세션 등록/in-memory active 설정만 하고 cursor catch-up이나 READ_EVENT 발행을 하지 않는다).
          // 따라서 disconnect 이전의 local pending을 여기서 재전송하지 않는다.
          resetReadReceipt();
          recoverHistoryAfterReconnect(spaceId);
        }
      }
      isInitialConnectRef.current = false;
    } else if (!connected && prevConnectedRef.current) {
      // 실제 연결 끊김(true→false)에서만 pending READ_UP_TO를 폐기한다.
      // 최초 마운트 시의 초기 connected=false는 prevConnectedRef.current도 초기값 false이므로 이 분기에 들어오지 않는다.
      discardPendingRead();
    }
    prevConnectedRef.current = connected;
  }, [connected, refreshSpaces, recoverHistoryAfterReconnect, resetReadReceipt, discardPendingRead]);

  // 좌측 상단 UserHeader 등 앱 전체 네트워크/소켓 상태를 나타내는 global connection state
  // (ENTER_ROOM synchronization 여부는 보지 않음)
  const globalConnectionState = useMemo(() => {
    if (!online) return "offline";
    if (!connected) return "reconnecting";
    return "online";
  }, [online, connected]);

  // 채팅방 선택
  const handleSelectSpace = useCallback(
    (spaceId) => {
      if (spaceId === selectedSpaceId) return;
      setPanelState(null);
      // 이전 방의 pending READ_UP_TO를 best-effort로 flush한 뒤(성공/실패와 무관하게) READ 상태 전체를 reset한다.
      // flushPendingRead는 selectedSpaceIdRef가 아니라 훅 내부 pendingRoomIdRef를 신뢰하므로, 여기서는 "이전 방"임을
      // 명시적으로 검증하기 위해 아직 갱신 전인 selectedSpaceId(이전 값)를 expectedRoomId로 전달한다.
      flushPendingRead(selectedSpaceId);
      resetReadReceipt();
      setSelectedSpaceId(spaceId);
      patchSpace(spaceId, { unreadMessageCount: 0 });
      loadHistoryForSpace(spaceId);
    },
    [selectedSpaceId, patchSpace, loadHistoryForSpace, flushPendingRead, resetReadReceipt]
  );

  usePendingInvite({ connected, spacesLoaded, spaces, onSelectSpace: handleSelectSpace });

  // 채팅방 나가기
  const handleLeaveRoom = useCallback(async () => {
    if (!selectedSpaceId) return;
    const spaceId = selectedSpaceId;
    try {
      await leaveSpace(spaceId);
      // 서버에서 이미 방을 나갔으므로(ROOM_NOT_JOINED) flush는 시도하지 않고 로컬 READ 상태만 정리한다
      resetReadReceipt();
      setSelectedSpaceId(null);
      setPanelState(null);
      removeSpace(spaceId);
    } catch (e) {
      // ignore
    }
  }, [selectedSpaceId, removeSpace, resetReadReceipt]);

  // 채팅방 이름 변경
  const handleRenameRoom = useCallback(async (newTitle) => {
    if (!selectedSpaceId || !newTitle.trim()) return;
    try {
      const result = await renameSpace(selectedSpaceId, newTitle.trim());
      patchSpace(result.data.chatRoomId, { title: result.data.title });
    } catch (e) {
      // ignore
    }
  }, [selectedSpaceId, patchSpace]);

  // Space 생성 완료: modal 닫기 + 목록 갱신 + 생성된 Space 자동 선택
  const handleSpaceCreated = useCallback((spaceId) => {
    setShowCreateModal(false);
    refreshSpaces();
    if (spaceId) handleSelectSpace(spaceId);
  }, [refreshSpaces, handleSelectSpace]);

  const handleOpenCreateModal = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  const handleBack = useCallback(() => {
    // 방 선택 해제는 사실상 방을 떠나는 동작이므로 방 전환과 동일한 순서로 정리한다
    flushPendingRead(selectedSpaceId);
    resetReadReceipt();
    setSelectedSpaceId(null);
  }, [selectedSpaceId, flushPendingRead, resetReadReceipt]);

  const handleToggleMembers = useCallback(() => {
    setPanelState((p) => (p?.type === "members" ? null : { type: "members" }));
  }, []);

  const handleOpenDiscussion = useCallback(
    (msg) => {
      setPanelState({ type: "discussion", message: msg });
      clearDiscussionEvents();
    },
    [clearDiscussionEvents]
  );

  const handleCloseMemberPanel = useCallback(() => {
    setPanelState(null);
  }, []);

  const handleCloseDiscussion = useCallback(() => {
    setPanelState(null);
    clearDiscussionEvents();
  }, [clearDiscussionEvents]);

  const membersOpen = panelState?.type === "members";
  const activeDiscussionChatId =
    panelState?.type === "discussion" ? panelState.message.chatId : null;

  return (
    <div className="orbit-workspace relative flex flex-col h-screen text-orbit-text overflow-hidden">
      <WorkspaceBackground />

      <ReconnectBanner connected={connected} reconnecting={reconnecting} />
      <WsErrorBanner wsError={wsError} onDismiss={() => setWsError(null)} />

      {/* 본문 — 3-column layout */}
      <div className="flex flex-1 overflow-hidden relative z-10">

        <ChatSidebar
          globalConnectionState={globalConnectionState}
          spaces={spaces}
          spacesError={spacesError}
          onRetrySpaces={refreshSpaces}
          selectedSpaceId={selectedSpaceId}
          onSelectSpace={handleSelectSpace}
          onCreateSpace={handleOpenCreateModal}
        />

        {/* ── Main Conversation ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedSpaceId ? (
            <SpaceWindow
              space={selectedSpace}
              messages={renderMessages}
              lastReadMessageId={lastReadMessageId}
              onSend={handleSend}
              loading={historyLoading}
              historyError={historyError}
              onBack={handleBack}
              onLeave={handleLeaveRoom}
              onRename={handleRenameRoom}
              connectionState={connectionState}
              enterRoomFailed={enterRoomFailed}
              enterRoomRetryable={enterRoomRetryable}
              onRetryEnterRoom={handleRetryEnterRoom}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              onLoadMore={handleLoadMore}
              onRetryHistory={handleRetryHistory}
              membersOpen={membersOpen}
              onToggleMembers={handleToggleMembers}
              onOpenDiscussion={handleOpenDiscussion}
              activeDiscussionChatId={activeDiscussionChatId}
              onRemoveFailedMessage={handleRemoveFailedMessage}
              onRetryMessage={handleRetryMessage}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-orbit-subtle">
              대화를 선택하세요.
            </div>
          )}
        </div>

        {/* ── Right Panel — 멤버 목록 ── */}
        {panelState?.type === "members" && selectedSpaceId && (
          <MemberPanel
            spaceId={selectedSpaceId}
            onClose={handleCloseMemberPanel}
          />
        )}

        {panelState?.type === "discussion" && (
          <DiscussionPanel
            message={panelState.message}
            incomingDiscussionEvents={incomingDiscussionEvents}
            onConsumeDiscussionEvents={consumeDiscussionEvents}
            sendDiscussionMessage={sendDiscussionMessage}
            connected={connected}
            onClose={handleCloseDiscussion}
          />
        )}
      </div>

      {showCreateModal && (
        <CreateSpaceModal
          onCreated={handleSpaceCreated}
          onClose={handleCloseCreateModal}
        />
      )}

    </div>
  );
}
