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
import { createDebouncer } from "../utils/debounce";
import SpaceWindow from "../components/chat/SpaceWindow";
import MemberPanel from "../components/chat/MemberPanel";
import DiscussionPanel from "../components/chat/DiscussionPanel";
import CreateSpaceModal from "../components/chat/CreateSpaceModal";
import WorkspaceBackground from "../components/chat/WorkspaceBackground";
import ReconnectBanner from "../components/chat/ReconnectBanner";
import WsErrorBanner from "../components/chat/WsErrorBanner";
import ChatSidebar from "../components/chat/ChatSidebar";

// READ_UP_TO 전송 debounce 지연시간 — 같은 room에서 연속 수신되는 메시지는 이 시간 동안 묶어 최신 chatId만 전송한다
const READ_UP_TO_DEBOUNCE_MS = 800;

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
  const handleReadEventRef = useRef(() => {});
  const handleChatMessageErrorRef = useRef(() => {});
  const handleDiscussionMessageCountRef = useRef(() => {});
  const clearMessagesRef = useRef(() => {});
  const handleEnterRoomAckRef = useRef(() => {});
  const handleEnterRoomErrorRef = useRef(() => {});
  const clearEnterRoomFailureRef = useRef(() => {});
  const memberLastReadRef = useRef({});
  const countedDiscussionMessageIdsRef = useRef(new Set());
  // handleMessage(CHAT_MESSAGE)가 최신 isSpaceActive/sendReadUpTo를 참조하도록 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const isSpaceActiveRef = useRef(() => false);
  const sendReadUpToRef = useRef(() => {});
  // 현재 room에서 서버로 보낼 예정인 read cursor (같은 debounce 창 안에서 여러 메시지가 오면 max로 누적)
  const pendingReadCursorRef = useRef(null);
  // 현재 room에서 마지막으로 실제 전송한 read cursor (중복 전송 방지)
  const lastSentReadCursorRef = useRef(null);
  // READ_UP_TO 전송을 debounce하는 인스턴스
  const readUpToDebouncerRef = useRef(createDebouncer(READ_UP_TO_DEBOUNCE_MS));

  // active 상태인 현재 room에서만 read cursor를 누적하고 debounce 후 READ_UP_TO를 예약한다.
  // pendingReadCursorRef는 항상 "지금까지 누적된 가장 큰 chatId"를 들고 있어,
  // debounce가 발화하는 시점에 참조해도 그 사이 도착한 최신 메시지의 chatId가 반영된다.
  const scheduleReadUpTo = useCallback((chatRoomId, chatId) => {
    if (chatId == null) return;
    if (!isSpaceActiveRef.current(chatRoomId)) return;

    pendingReadCursorRef.current =
      pendingReadCursorRef.current == null
        ? chatId
        : Math.max(pendingReadCursorRef.current, chatId);

    readUpToDebouncerRef.current.schedule(() => {
      const cursor = pendingReadCursorRef.current;
      if (cursor == null) return;
      if (lastSentReadCursorRef.current != null && cursor <= lastSentReadCursorRef.current) return;

      lastSentReadCursorRef.current = cursor;
      sendReadUpToRef.current(chatRoomId, cursor);
    });
  }, []);

  // WebSocket 수신 메시지 처리
  const handleMessage = useCallback(
    (data) => {
      switch (data.messageType) {
        case "CHAT_MESSAGE":
          if (data.chatRoomId === selectedSpaceIdRef.current) {
            handleChatMessageRef.current(data);
            scheduleReadUpTo(data.chatRoomId, data.chatId);
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

        case "READ_EVENT": {
          if (data.chatRoomId !== selectedSpaceIdRef.current) break;

          const lastProcessed = memberLastReadRef.current[data.memberId] ?? null;
          if (lastProcessed !== null && data.currentLastReadChatId <= lastProcessed) break;

          memberLastReadRef.current[data.memberId] = data.currentLastReadChatId;

          handleReadEventRef.current(data);

          break;
        }

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
      scheduleReadUpTo,
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
    handleReadEvent,
    handleDiscussionMessageCount,
    handleSend,
    handleRetryMessage,
    handleRemoveFailedMessage,
    clearMessages,
  } = useRoomHistory({ selectedSpaceId, selectedSpaceIdRef, connectionState, sendChatMessage, auth });

  // handleMessage가 useRoomHistory보다 먼저 선언되어 최신 핸들러를 직접 참조할 수 없으므로 ref로 동기화한다 (notifyEnteredRef와 동일한 이유)
  useEffect(() => {
    handleChatMessageRef.current = handleChatMessage;
    handleReadEventRef.current = handleReadEvent;
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
  });

  // handleMessage(ENTER_ROOM_ACK)가 최신 notifyEntered를 참조하도록 매 렌더마다 동기화한다
  useEffect(() => {
    notifyEnteredRef.current = notifyEntered;
  });

  // handleMessage(CHAT_MESSAGE)가 최신 sendReadUpTo/isSpaceActive를 참조하도록 매 렌더마다 동기화한다
  useEffect(() => {
    sendReadUpToRef.current = sendReadUpTo;
    isSpaceActiveRef.current = isSpaceActive;
  });

  // 컴포넌트 unmount 시 예약된 READ_UP_TO debounce timer를 정리한다
  useEffect(() => {
    const debouncer = readUpToDebouncerRef.current;
    return () => {
      debouncer.cancel();
    };
  }, []);

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
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      if (!isInitialConnectRef.current) {
        refreshSpaces();

        const spaceId = selectedSpaceIdRef.current;
        if (spaceId !== null) {
          memberLastReadRef.current = {};
          readUpToDebouncerRef.current.cancel();
          pendingReadCursorRef.current = null;
          lastSentReadCursorRef.current = null;
          recoverHistoryAfterReconnect(spaceId);
        }
      }
      isInitialConnectRef.current = false;
    }
    prevConnectedRef.current = connected;
  }, [connected, refreshSpaces, recoverHistoryAfterReconnect]);

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
      memberLastReadRef.current = {};
      readUpToDebouncerRef.current.cancel();
      pendingReadCursorRef.current = null;
      lastSentReadCursorRef.current = null;
      setSelectedSpaceId(spaceId);
      patchSpace(spaceId, { unreadMessageCount: 0 });
      loadHistoryForSpace(spaceId);
    },
    [selectedSpaceId, patchSpace, loadHistoryForSpace]
  );

  usePendingInvite({ connected, spacesLoaded, spaces, onSelectSpace: handleSelectSpace });

  // 채팅방 나가기
  const handleLeaveRoom = useCallback(async () => {
    if (!selectedSpaceId) return;
    const spaceId = selectedSpaceId;
    try {
      await leaveSpace(spaceId);
      setSelectedSpaceId(null);
      setPanelState(null);
      removeSpace(spaceId);
    } catch (e) {
      // ignore
    }
  }, [selectedSpaceId, removeSpace]);

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
    setSelectedSpaceId(null);
  }, []);

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
