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
  // 서버가 ENTER_ROOM_ACK로 입장을 확인한 selectedSpaceId (enteredSpaceIdRef의 상태 버전). ENTER_ROOM 전송만으로는 설정되지 않는다.
  const [enteredSpaceId, setEnteredSpaceId] = useState(null);
  // 현재 selectedSpaceId에 대한 ENTER_ROOM이 ERROR로 실패해 재시도 UI를 보여줘야 하는지. wsError(4초 후 자동 소멸)와 독립적으로 유지된다.
  const [enterRoomFailed, setEnterRoomFailed] = useState(false);
  // enterRoomFailed=true인 실패 중에서 "다시 보내면 성공할 가능성이 있는지". INVALID_REQUEST(FE 요청/프로토콜 오류)처럼 같은 요청을 반복해도 성공할 수 없는 경우에만 false가 된다.
  const [enterRoomRetryable, setEnterRoomRetryable] = useState(true);

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
  // ENTER_ROOM_ACK를 수신해 서버가 입장을 확인한 selectedSpaceId
  const enteredSpaceIdRef = useRef(null);
  // ENTER_ROOM을 보냈지만 아직 ACK/ERROR 응답을 받지 못한 spaceId. 중복 ENTER_ROOM 전송 방지용으로만 쓰인다.
  // ACK/ERROR 매칭은 이 ref가 아니라 selectedSpaceIdRef와의 비교로만 판단한다 (timeout이 없으므로 "이미 해제된 pending"이라는 개념이 없다)
  const pendingEnterRoomSpaceIdRef = useRef(null);
  // handleMessage(useCallback)가 useSpaceActivity보다 먼저 선언되어 notifyEntered를 직접 참조할 수 없으므로 ref로 우회한다
  const notifyEnteredRef = useRef(() => {});
  // handleMessage가 useRoomHistory보다 먼저 선언되어 최신 핸들러를 직접 참조할 수 없으므로 ref로 우회한다 (notifyEnteredRef와 동일한 이유)
  const handleChatMessageRef = useRef(() => {});
  const handleReadEventRef = useRef(() => {});
  const handleChatMessageErrorRef = useRef(() => {});
  const handleDiscussionMessageCountRef = useRef(() => {});
  const clearMessagesRef = useRef(() => {});
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

          // 같은 spaceId로 대기 중이던 pending이면 dedup 가드를 해제한다 (일치하지 않아도 ACK 반영 자체는 막지 않는다)
          if (pendingEnterRoomSpaceIdRef.current === data.chatRoomId) {
            pendingEnterRoomSpaceIdRef.current = null;
          }
          enteredSpaceIdRef.current = data.chatRoomId;
          setEnteredSpaceId(data.chatRoomId);
          setEnterRoomFailed(false);
          setEnterRoomRetryable(true);
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
            // 같은 spaceId로 대기 중이던 pending이면 dedup 가드를 해제한다
            if (pendingEnterRoomSpaceIdRef.current === data.chatRoomId) {
              pendingEnterRoomSpaceIdRef.current = null;
            }
            enteredSpaceIdRef.current = null;
            setEnteredSpaceId(null);
            // 재시도 UI 노출 — 사용자가 명시적으로 재시도하기 전까지 유지된다 (자동 재시도 없음)
            setEnterRoomFailed(true);
            // INVALID_REQUEST(FE 요청/프로토콜 오류), UNAUTHORIZED(로그인 만료)는 같은 요청을 다시 보내도
            // 성공할 가능성이 낮으므로 재시도 버튼을 숨긴다
            setEnterRoomRetryable(
              data.errorCode !== "INVALID_REQUEST" &&
              data.errorCode !== "UNAUTHORIZED"
            );
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
              setEnterRoomFailed(false);
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
      setEnteredSpaceId,
      setEnterRoomFailed,
      setEnterRoomRetryable,
      refreshSpaces,
      clearDiscussionEvents,
      scheduleReadUpTo,
    ]
  );

  const { connected, reconnecting, sendEnterRoom, sendChatMessage, sendRoomActive, sendRoomInactive, sendReadUpTo, sendDiscussionMessage } = useWebSocket(handleMessage);

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

  // ENTER_ROOM 전송 + 대기 상태 기록의 단일 진입점. 최초 전송(effect)과 사용자의 명시적 재시도(retryEnterRoom)가 공유한다.
  // 같은 spaceId로 이미 보내고 ACK/ERROR를 기다리는 중이면(ref는 동기로 즉시 반영되므로 더블클릭/중복 호출에도 안전) 재전송하지 않는다.
  // timeout 없이 ACK 또는 ERROR가 올 때까지 synchronizing 상태를 유지한다 (handleMessage의 ENTER_ROOM_ACK/ERROR 분기 참고).
  const triggerEnterRoom = useCallback(
    (spaceId) => {
      if (pendingEnterRoomSpaceIdRef.current === spaceId) return;

      pendingEnterRoomSpaceIdRef.current = spaceId;
      sendEnterRoom(spaceId);
    },
    [sendEnterRoom]
  );

  // ENTER_ROOM 전송: 응답(ACK/ERROR)을 기다리지 않고 전송만 수행한다.
  // enteredSpaceId/enteredSpaceIdRef는 ENTER_ROOM_ACK 수신 시에만 설정된다 (handleMessage 참고).
  useEffect(() => {
    if (!connected) return;

    if (selectedSpaceId === null) {
      pendingEnterRoomSpaceIdRef.current = null;
      enteredSpaceIdRef.current = null;
      setEnteredSpaceId(null);
      setEnterRoomFailed(false);
      setEnterRoomRetryable(true);
      return;
    }

    if (enteredSpaceIdRef.current === selectedSpaceId) return;

    // 중복 전송 방지는 triggerEnterRoom 내부 가드가 단일하게 담당한다
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
    triggerEnterRoom(selectedSpaceId);
  }, [connected, selectedSpaceId, triggerEnterRoom]);

  useEffect(() => {
    if (!connected) {
      pendingEnterRoomSpaceIdRef.current = null;
      enteredSpaceIdRef.current = null;
      setEnteredSpaceId(null);
      setEnterRoomFailed(false);
      setEnterRoomRetryable(true);
    }
  }, [connected]);

  // ENTER_ROOM 실패 후 사용자가 명시적으로 재시도할 때만 호출된다. 자동 재시도/타이머/백오프는 없다.
  const retryEnterRoom = useCallback(() => {
    if (!selectedSpaceId || !connected) return;
    // 같은 메시지로 다시 실패해도 4초 배너가 온전히 재노출되도록 먼저 비운다 (useWsErrorBanner는 값이 바뀔 때만 타이머를 재시작함)
    setWsError(null);
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
    triggerEnterRoom(selectedSpaceId);
  }, [selectedSpaceId, connected, setWsError, triggerEnterRoom]);

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
              onRetryEnterRoom={retryEnterRoom}
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
