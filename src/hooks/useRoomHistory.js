import { useCallback, useMemo, useRef, useState } from "react";
import { getMessageHistory } from "../api/messageApi";
import {
  mergeMessagesById,
  applyReadEvents,
  removePendingByClientMessageId,
  markPendingMessageFailed,
  markPendingMessageSending,
} from "../utils/messageState";

// CHAT_MESSAGE ERROR의 errorCode 중 재시도해도 동일하게 실패하는 errorCode.
// ROOM_NOT_JOINED은 handleRetryMessage가 ENTER_ROOM을 재전송하지 않아 메시지 재시도만으로 복구되지 않는다.
// 여기 없는 errorCode(INTERNAL_ERROR 등)는 재시도 가능으로 간주한다(fail-open).
const CHAT_MESSAGE_NON_RETRYABLE_ERROR_CODES = new Set([
  "ROOM_NOT_JOINED",
  "ROOM_NOT_FOUND",
  "UNAUTHORIZED",
  "INVALID_MESSAGE",
]);

// 메시지 목록·pending 메시지·history 조회 상태와 동작을 관리한다.
// selectedSpaceId 변경, ENTER_ROOM, READ_UP_TO, WebSocket 연결/재연결 감지, Discussion 흐름 자체는 호출 측(ChatPage)이 소유한다.
export function useRoomHistory({ selectedSpaceId, selectedSpaceIdRef, connectionState, sendChatMessage, auth }) {
  const [messages, setMessages] = useState([]);
  // FE에서만 존재하는 전송 중 메시지 (echo reconciliation 이전 단계, clientMessageId로 식별)
  const [pendingMessages, setPendingMessages] = useState([]);
  const [lastReadMessageId, setLastReadMessageId] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [oldestChatId, setOldestChatId] = useState(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const historyFetchIdRef = useRef(0);

  // 방 선택 / 재시도 / 재연결 복구가 공유하는 기본 history 조회 흐름.
  // fetchId·selectedSpaceIdRef 방어 조건으로 stale 응답을 무시한다 (호출부의 초기화 범위만 서로 다르다).
  const runHistoryFetch = useCallback(
    (spaceId) => {
      setHistoryLoading(true);
      setHistoryError(false);
      const fetchId = ++historyFetchIdRef.current;

      getMessageHistory(spaceId)
        .then((result) => {
          if (fetchId !== historyFetchIdRef.current) return;
          if (spaceId !== selectedSpaceIdRef.current) return;
          const { messages: msgs, lastReadMessageId, hasMore: more } = result.data;
          setMessages((prev) => mergeMessagesById(prev, msgs ?? []));
          setLastReadMessageId(lastReadMessageId ?? null);
          setHasMore(more ?? false);
          setOldestChatId(msgs?.[0]?.chatId ?? null);
          setHistoryError(false);
        })
        .catch(() => {
          if (fetchId !== historyFetchIdRef.current) return;
          setHistoryError(true);
        })
        .finally(() => {
          if (fetchId !== historyFetchIdRef.current) return;
          setHistoryLoading(false);
        });
    },
    [selectedSpaceIdRef]
  );

  const loadHistoryForSpace = useCallback(
    (spaceId) => {
      setMessages([]);
      setPendingMessages([]);
      setLastReadMessageId(null);
      setHasMore(false);
      setOldestChatId(null);
      setIsLoadingMore(false);
      runHistoryFetch(spaceId);
    },
    [runHistoryFetch]
  );

  // 재연결 복구 시 lastReadMessageId/hasMore/oldestChatId는 초기화하지 않는다(기존 동작 유지).
  const recoverHistoryAfterReconnect = useCallback(
    (spaceId) => {
      setMessages([]);
      setPendingMessages([]);
      setIsLoadingMore(false);
      runHistoryFetch(spaceId);
    },
    [runHistoryFetch]
  );

  // 기존 messages/pendingMessages는 유지한 채 재조회한다.
  const handleRetryHistory = useCallback(() => {
    if (!selectedSpaceId) return;
    runHistoryFetch(selectedSpaceId);
  }, [selectedSpaceId, runHistoryFetch]);

  // 이전 메시지 로드 — historyFetchIdRef를 증가시키지 않고 현재 세대를 읽기만 한다.
  // 실패해도 historyError는 건드리지 않고, mergeMessagesById 대신 단순 결합을 사용한다 (기존 동작 유지).
  const handleLoadMore = useCallback(() => {
    if (!hasMore || isLoadingMore || !oldestChatId) return;
    setIsLoadingMore(true);
    const fetchId = historyFetchIdRef.current;
    getMessageHistory(selectedSpaceId, oldestChatId)
      .then((result) => {
        if (fetchId !== historyFetchIdRef.current) return;
        const { messages: older, hasMore: more } = result.data;
        setMessages((prev) => [...(older ?? []), ...prev]);
        setHasMore(more ?? false);
        setOldestChatId(older?.[0]?.chatId ?? oldestChatId);
      })
      .catch(() => {})
      .finally(() => setIsLoadingMore(false));
  }, [hasMore, isLoadingMore, oldestChatId, selectedSpaceId]);

  // WebSocket CHAT_MESSAGE 반영: pending 제거 + messages 병합만 담당한다.
  // data.chatRoomId === selectedSpaceIdRef.current 판단과 scheduleReadUpTo 호출은 호출 측(ChatPage)이 담당한다.
  const handleChatMessage = useCallback((data) => {
    setPendingMessages((prev) => removePendingByClientMessageId(prev, data.clientMessageId));
    setMessages((prev) => mergeMessagesById(prev, [data]));
  }, []);

  // WebSocket ERROR(requestType=CHAT_MESSAGE) 시 호출된다.
  const handleChatMessageError = useCallback((clientMessageId, errorCode) => {
    // errorCode/retryable은 markPendingMessageFailed가 다루는 status와 별개 필드로 얹는다.
    setPendingMessages((prev) =>
      markPendingMessageFailed(prev, clientMessageId).map((p) =>
        p.clientMessageId === clientMessageId
          ? {
              ...p,
              errorCode,
              retryable: !CHAT_MESSAGE_NON_RETRYABLE_ERROR_CODES.has(errorCode),
            }
          : p
      )
    );
  }, []);

  // WebSocket READ_EVENT/READ_EVENT_BATCH 반영 — 호출 측(ChatPage)이 room 일치 검사와 멤버별
  // 중복 병합·stale 판단(useReadReceipt.selectApplicableReadEvents)을 마친 이벤트 배열만 전달한다.
  // 단건 READ_EVENT도 배열 1개로 감싸 동일한 경로를 타므로, item 개수와 무관하게 setMessages는 한 번만 호출된다.
  const handleReadEventBatch = useCallback((readEvents) => {
    if (!readEvents || readEvents.length === 0) return;
    setMessages((prev) => applyReadEvents(prev, readEvents));
  }, []);

  // WebSocket DISCUSSION_MESSAGE_EVENT 반영 — 호출 측이 dedup(discussionMessageId) 판단을 마친 이벤트만 전달한다.
  // 원본 메시지의 discussionMessageCount/discussionId만 갱신한다 (Discussion 패널 자체 로직은 다루지 않는다).
  const handleDiscussionMessageCount = useCallback((data) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.chatId === data.chatId
          ? {
              ...msg,
              discussionMessageCount: (msg.discussionMessageCount ?? 0) + 1,
              discussionId: msg.discussionId ?? data.discussionId,
            }
          : msg
      )
    );
  }, []);

  const handleSend = useCallback(
    (message) => {
      const clientMessageId = crypto.randomUUID();

      setPendingMessages((prev) => [
        ...prev,
        {
          clientMessageId,
          chatRoomId: selectedSpaceId,
          message,
          senderId: auth?.memberId,
          senderNickname: auth?.nickname,
          createdDate: new Date().toISOString(),
          status: "sending",
          isTemporary: true,
        },
      ]);

      sendChatMessage(selectedSpaceId, message, clientMessageId);
    },
    [selectedSpaceId, sendChatMessage, auth]
  );

  // 같은 clientMessageId로 재전송해 서버 echo와 매칭되게 한다.
  const handleRetryMessage = useCallback(
    (clientMessageId) => {
      if (connectionState !== "ready") return;

      const target = pendingMessages.find(
        (p) => p.clientMessageId === clientMessageId && p.status === "failed"
      );
      if (!target) return;

      setPendingMessages((prev) => markPendingMessageSending(prev, clientMessageId));
      sendChatMessage(target.chatRoomId, target.message, clientMessageId);
    },
    [connectionState, pendingMessages, sendChatMessage]
  );

  // local-only — 서버 요청 없음.
  const handleRemoveFailedMessage = useCallback((clientMessageId) => {
    setPendingMessages((prev) => removePendingByClientMessageId(prev, clientMessageId));
  }, []);

  // history 재조회 없이 messages/pendingMessages만 비운다 (예: Space가 더 이상 접근 불가로 확인된 경우).
  const clearMessages = useCallback(() => {
    setMessages([]);
    setPendingMessages([]);
  }, []);

  const renderMessages = useMemo(
    () => [...messages, ...pendingMessages],
    [messages, pendingMessages]
  );

  return {
    messages,
    pendingMessages,
    renderMessages,
    lastReadMessageId,
    historyLoading,
    historyError,
    hasMore,
    oldestChatId,
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
  };
}
