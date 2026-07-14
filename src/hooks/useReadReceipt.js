import { useCallback, useEffect, useRef } from "react";
import { createDebouncer } from "../utils/debounce";

// READ_UP_TO 전송 debounce 지연시간 — 같은 room에서 연속 수신되는 메시지는 이 시간 동안 묶어 최신 chatId만 전송한다
const READ_UP_TO_DEBOUNCE_MS = 800;

// READ_UP_TO cursor 누적/전송과 READ_EVENT 멤버별 stale 판단만 담당한다.
// chatRoomId/selectedSpaceId 일치 검사, messages 반영(useRoomHistory), ROOM_ACTIVE/INACTIVE 전송(useSpaceActivity)은
// 호출 측(ChatPage)이 소유한다.
export function useReadReceipt({ sendReadUpTo, isSpaceActive }) {
  // 현재 room에서 멤버별로 마지막으로 반영한 read cursor (READ_EVENT stale/역전 판단용)
  const memberLastReadRef = useRef({});
  // 현재 room에서 서버로 보낼 예정인 read cursor (같은 debounce 창 안에서 여러 메시지가 오면 max로 누적)
  const pendingReadCursorRef = useRef(null);
  // 현재 room에서 마지막으로 실제 전송한 read cursor (중복 전송 방지)
  const lastSentReadCursorRef = useRef(null);
  // READ_UP_TO 전송을 debounce하는 인스턴스
  const readUpToDebouncerRef = useRef(createDebouncer(READ_UP_TO_DEBOUNCE_MS));

  // debounce callback은 오래 유지되므로, 렌더 시점의 오래된 함수를 캡처하지 않도록 최신 입력을 ref로 동기화한다
  const sendReadUpToRef = useRef(sendReadUpTo);
  const isSpaceActiveRef = useRef(isSpaceActive);

  useEffect(() => {
    sendReadUpToRef.current = sendReadUpTo;
    isSpaceActiveRef.current = isSpaceActive;
  }, [sendReadUpTo, isSpaceActive]);

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

  // READ_EVENT의 멤버별 stale/역전 판단만 수행한다.
  // chatRoomId 일치 검사, messages 반영(applyReadEvent), lastReadMessageId 갱신은 호출 측(ChatPage/useRoomHistory)이 담당한다.
  const shouldApplyReadEvent = useCallback((event) => {
    const lastProcessed = memberLastReadRef.current[event.memberId] ?? null;
    if (lastProcessed !== null && event.currentLastReadChatId <= lastProcessed) return false;

    memberLastReadRef.current[event.memberId] = event.currentLastReadChatId;
    return true;
  }, []);

  // 방 전환 / 재연결 시 읽음 추적 상태를 초기화한다.
  const resetReadReceipt = useCallback(() => {
    memberLastReadRef.current = {};
    readUpToDebouncerRef.current.cancel();
    pendingReadCursorRef.current = null;
    lastSentReadCursorRef.current = null;
  }, []);

  // 컴포넌트 unmount 시 예약된 READ_UP_TO debounce timer를 정리한다
  useEffect(() => {
    const debouncer = readUpToDebouncerRef.current;
    return () => {
      debouncer.cancel();
    };
  }, []);

  return { scheduleReadUpTo, shouldApplyReadEvent, resetReadReceipt };
}
