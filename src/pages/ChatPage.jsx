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

  // null | { type: "members" } | { type: "discussion", message }
  const [panelState, setPanelState] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  const selectedSpaceIdRef = useRef(null);
  const prevConnectedRef = useRef(false);
  const isInitialConnectRef = useRef(true);
  // handleMessage가 여러 hook보다 먼저 선언되어 최신 handler/상태를 직접 참조할 수 없으므로, 아래 ref들로 동기화해 우회한다.
  const notifyEnteredRef = useRef(() => {});
  const handleChatMessageRef = useRef(() => {});
  const handleReadEventBatchRef = useRef(() => {});
  const handleChatMessageErrorRef = useRef(() => {});
  const handleDiscussionMessageCountRef = useRef(() => {});
  const clearMessagesRef = useRef(() => {});
  const handleEnterRoomAckRef = useRef(() => {});
  const handleEnterRoomErrorRef = useRef(() => {});
  const clearEnterRoomFailureRef = useRef(() => {});
  const countedDiscussionMessageIdsRef = useRef(new Set());
  const isSpaceActiveRef = useRef(() => false);
  const scheduleReadUpToRef = useRef(() => {});
  const selectApplicableReadEventsRef = useRef(() => []);
  const onBeforeInactiveRef = useRef(() => {});

  const handleMessage = useCallback(
    (data) => {
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
          // 다른 Space로 전환된 뒤 도착한 stale ACK는 무시한다(timeout이 없어 이 비교가 유일한 매칭 기준).
          if (data.chatRoomId !== selectedSpaceIdRef.current) break;

          handleEnterRoomAckRef.current(data.chatRoomId);
          // ENTER_ROOM이 서버에서 active 등록까지 수행하므로, ACK로 확인된 이후에만 active로 간주한다.
          notifyEnteredRef.current(data.chatRoomId);
          break;

        case "ERROR": {
          console.warn("WS ERROR", {
            requestType: data.requestType,
            errorCode: data.errorCode,
            chatRoomId: data.chatRoomId,
          });

          // 다른 Space로 전환된 뒤 도착한 stale ERROR는 무시한다.
          const isEnterRoomError =
            data.requestType === "ENTER_ROOM" &&
            data.chatRoomId === selectedSpaceIdRef.current;

          if (data.requestType === "CHAT_MESSAGE" && data.clientMessageId) {
            handleChatMessageErrorRef.current(data.clientMessageId, data.errorCode);
          }

          if (isEnterRoomError) {
            handleEnterRoomErrorRef.current(data.chatRoomId, data.errorCode);
          }

          // INTERNAL_ERROR는 권한/목록 문제가 아니라 서버 내부 처리 실패다 — BE 원문은 "재시도해도 되는지"가 불명확해 FE에서만 문구를 보완한다.
          if (isEnterRoomError && data.errorCode === "INTERNAL_ERROR") {
            setWsError("일시적인 오류로 채팅방 입장에 실패했습니다. 다시 시도해주세요.");
          } else if (isEnterRoomError && data.errorCode === "INVALID_REQUEST") {
            setWsError("방에 입장할 수 없습니다. 새로고침 후 다시 시도해주세요.");
          } else if (isEnterRoomError && data.errorCode === "UNAUTHORIZED") {
            // 지금은 안내만 한다 — 자동 로그아웃/페이지 이동은 별도 작업에서 다룬다.
            setWsError("로그인이 만료되었습니다. 다시 로그인해주세요.");
          } else {
            setWsError(data.message);
          }

          // 서버가 비참여자도 ROOM_NOT_FOUND로 내려줄 수 있어, ROOM_NOT_FOUND/FORBIDDEN은 Space 목록을 다시 조회해 실제 접근 가능 여부를 확인한다.
          if (isEnterRoomError && (data.errorCode === "ROOM_NOT_FOUND" || data.errorCode === "FORBIDDEN")) {
            const erroredSpaceId = data.chatRoomId;

            refreshSpaces().then((refreshedSpaces) => {
              // refresh가 끝나기 전에 다른 Space로 이동했으면 이 결과는 더 이상 유효하지 않다.
              if (selectedSpaceIdRef.current !== erroredSpaceId) return;
              // refresh 자체가 실패하면 접근 가능 여부를 판단할 수 없으므로 기존 재시도 UI를 그대로 둔다.
              if (refreshedSpaces === null) return;

              const stillAccessible = refreshedSpaces.some((s) => s.chatRoomId === erroredSpaceId);
              if (stillAccessible) return;

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

  useEffect(() => {
    handleEnterRoomAckRef.current = handleEnterRoomAck;
    handleEnterRoomErrorRef.current = handleEnterRoomError;
    clearEnterRoomFailureRef.current = clearEnterRoomFailure;
  });

  // wsError는 useRoomEntry가 모르는 공용 배너라 여기서 함께 비운다.
  const handleRetryEnterRoom = useCallback(() => {
    // 같은 메시지로 다시 실패해도 4초 배너가 온전히 재노출되도록 먼저 비운다(useWsErrorBanner는 값이 바뀔 때만 타이머를 재시작함).
    setWsError(null);
    retryEnterRoom();
  }, [retryEnterRoom, setWsError]);

  // offline/reconnecting/synchronizing/ready — Space 메시지 전송 가능 여부를 나타내는 connection state.
  // useRoomHistory(handleRetryMessage)가 필요로 하므로 이 hook 호출보다 앞서 계산해둔다.
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

  useEffect(() => {
    handleChatMessageRef.current = handleChatMessage;
    handleReadEventBatchRef.current = handleReadEventBatch;
    handleChatMessageErrorRef.current = handleChatMessageError;
    handleDiscussionMessageCountRef.current = handleDiscussionMessageCount;
    clearMessagesRef.current = clearMessages;
  });

  // handleSelectSpace의 낙관적 초기화와 별개로, 서버 activity 전환(useSpaceActivity) 시점에 unread를 최종 보정한다.
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

  // blur/hidden은 같은 방을 유지하므로 resetReadReceipt() 대신 flush+discard만 수행해 memberLastReadRef를 보존한다.
  useEffect(() => {
    onBeforeInactiveRef.current = (spaceId) => {
      flushPendingRead(spaceId);
      discardPendingRead();
    };
  });

  useEffect(() => {
    notifyEnteredRef.current = notifyEntered;
  });

  useEffect(() => {
    isSpaceActiveRef.current = isSpaceActive;
  });

  useEffect(() => {
    scheduleReadUpToRef.current = scheduleReadUpTo;
    selectApplicableReadEventsRef.current = selectApplicableReadEvents;
  });

  // 여러 stale 비교에서 참조하므로 selectedSpaceId를 최신값으로 동기화한다.
  useEffect(() => { selectedSpaceIdRef.current = selectedSpaceId; }, [selectedSpaceId]);

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

  // prevConnectedRef로 false↔true 전이 방향을 구분한다 — 연결 끊김 정리(READ 상태)는 아래 else 분기가 담당한다.
  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      if (!isInitialConnectRef.current) {
        refreshSpaces();

        const spaceId = selectedSpaceIdRef.current;
        if (spaceId !== null) {
          // ENTER_ROOM은 cursor catch-up을 하지 않으므로(BE 확인됨), 여기서 disconnect 이전 pending read를 재전송하지 않는다.
          resetReadReceipt();
          recoverHistoryAfterReconnect(spaceId);
        }
      }
      isInitialConnectRef.current = false;
    } else if (!connected && prevConnectedRef.current) {
      // true→false 전이에서만 폐기한다 — 초기 마운트의 connected=false는 prevConnectedRef 초기값과 같아 이 분기에 들어오지 않는다.
      discardPendingRead();
    }
    prevConnectedRef.current = connected;
  }, [connected, refreshSpaces, recoverHistoryAfterReconnect, resetReadReceipt, discardPendingRead]);

  // connectionState와 달리 ENTER_ROOM synchronization 여부는 반영하지 않는, UserHeader 등 전역 표시용 상태.
  const globalConnectionState = useMemo(() => {
    if (!online) return "offline";
    if (!connected) return "reconnecting";
    return "online";
  }, [online, connected]);

  const handleSelectSpace = useCallback(
    (spaceId) => {
      if (spaceId === selectedSpaceId) return;
      setPanelState(null);
      // 아직 갱신 전인 selectedSpaceId(이전 방)를 flushPendingRead의 expectedRoomId로 전달해 "이전 방" 검증에 사용한다.
      flushPendingRead(selectedSpaceId);
      resetReadReceipt();
      setSelectedSpaceId(spaceId);
      patchSpace(spaceId, { unreadMessageCount: 0 });
      loadHistoryForSpace(spaceId);
    },
    [selectedSpaceId, patchSpace, loadHistoryForSpace, flushPendingRead, resetReadReceipt]
  );

  usePendingInvite({ connected, spacesLoaded, spaces, onSelectSpace: handleSelectSpace });

  const handleLeaveRoom = useCallback(async () => {
    if (!selectedSpaceId) return;
    const spaceId = selectedSpaceId;
    try {
      await leaveSpace(spaceId);
      // 서버에서 이미 방을 나갔으므로(ROOM_NOT_JOINED) flush는 시도하지 않고 로컬 READ 상태만 정리한다.
      resetReadReceipt();
      setSelectedSpaceId(null);
      setPanelState(null);
      removeSpace(spaceId);
    } catch (e) {
      // ignore
    }
  }, [selectedSpaceId, removeSpace, resetReadReceipt]);

  const handleRenameRoom = useCallback(async (newTitle) => {
    if (!selectedSpaceId || !newTitle.trim()) return;
    try {
      const result = await renameSpace(selectedSpaceId, newTitle.trim());
      patchSpace(result.data.chatRoomId, { title: result.data.title });
    } catch (e) {
      // ignore
    }
  }, [selectedSpaceId, patchSpace]);

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
    // 방 선택 해제는 사실상 방을 떠나는 동작이므로 방 전환과 동일한 순서로 정리한다.
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
