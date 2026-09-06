import { useCallback, useEffect, useRef } from "react";

// READ_UP_TO 전송 정책 — leading 1회 즉시 전송 후, 1초 동안 도착한 cursor는 최신값만 모아 한 번 더 전송한다.
const READ_UP_TO_THROTTLE_MS = 1000;

// READ_UP_TO cursor 누적/전송과 READ_EVENT 멤버별 stale 판단만 담당한다.
// chatRoomId/selectedSpaceId 일치 검사, messages 반영(useRoomHistory), ROOM_ACTIVE/INACTIVE 전송(useSpaceActivity)은
// 호출 측(ChatPage)이 소유한다.
//
// Orbit는 한 시점에 하나의 선택된 방에 대한 READ 상태만 관리하며 방 전환 시 resetReadReceipt()로 전체 초기화하므로,
// lastSentReadCursorRef/pendingReadCursorRef에는 방을 구분하는 별도 ref(lastSentRoomIdRef)를 두지 않는다.
export function useReadReceipt({ sendReadUpTo, isSpaceActive }) {
  // READ_EVENT stale/역전 판단용 — 멤버별 마지막 반영 cursor
  const memberLastReadRef = useRef({});

  // 아직 서버로 보내지 못한 read cursor. 항상 pendingReadCursorRef와 한 쌍으로 관리한다
  // (pending 없음 → 둘 다 null / pending 있음 → 둘 다 값 존재).
  const pendingRoomIdRef = useRef(null);
  const pendingReadCursorRef = useRef(null);

  // throttle 창의 기준점
  const lastSentReadCursorRef = useRef(null);
  const lastSentAtRef = useRef(null);

  // 최대 1개만 존재한다(중복 예약 방지).
  const trailingTimerRef = useRef(null);

  // callback은 오래 유지되므로, 렌더 시점의 오래된 함수를 캡처하지 않도록 최신 입력을 ref로 동기화한다
  const sendReadUpToRef = useRef(sendReadUpTo);
  const isSpaceActiveRef = useRef(isSpaceActive);

  useEffect(() => {
    sendReadUpToRef.current = sendReadUpTo;
    isSpaceActiveRef.current = isSpaceActive;
  }, [sendReadUpTo, isSpaceActive]);

  const cancelTrailingTimer = useCallback(() => {
    if (trailingTimerRef.current != null) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
  }, []);

  // expectedRoomId가 주어지면 pendingRoomIdRef와 일치할 때만 전송해 다른 방의 pending을 실수로 보내지 않는다.
  // isSpaceActive는 여기서 재검사하지 않는다 — 방 전환/inactive 전환 "직전"에도 호출되므로 flush 자체가 차단되면 안 된다.
  const flushPendingRead = useCallback((expectedRoomId) => {
    const roomId = pendingRoomIdRef.current;
    const cursor = pendingReadCursorRef.current;
    if (roomId == null || cursor == null) return;
    if (expectedRoomId !== undefined && expectedRoomId !== roomId) return;

    const ok = sendReadUpToRef.current(roomId, cursor);
    if (!ok) return; // 실패 — lastSent 갱신 금지, pending 유지, 자동 재시도 timer 생성 금지

    lastSentReadCursorRef.current = cursor;
    lastSentAtRef.current = Date.now();
    cancelTrailingTimer();

    // 전송 도중 더 큰 pending이 들어왔을 가능성을 대비해, 방금 보낸 값 이하일 때만 pending을 비운다.
    if (
      pendingRoomIdRef.current === roomId &&
      pendingReadCursorRef.current != null &&
      pendingReadCursorRef.current <= cursor
    ) {
      pendingRoomIdRef.current = null;
      pendingReadCursorRef.current = null;
    }
  }, [cancelTrailingTimer]);

  const armTrailingTimer = useCallback((remainingMs) => {
    if (trailingTimerRef.current != null) return;
    trailingTimerRef.current = setTimeout(() => {
      trailingTimerRef.current = null;
      // 예약 당시 cursor를 closure로 들고 있지 않고, 발화 시점에 ref에서 최신 pending을 읽는다.
      flushPendingRead();
    }, remainingMs);
  }, [flushPendingRead]);

  const scheduleReadUpTo = useCallback((chatRoomId, chatId) => {
    if (chatRoomId == null || chatId == null) return;
    if (!isSpaceActiveRef.current(chatRoomId)) return;

    // cursor는 뒤로 이동하지 않는다 — 이미 반영(또는 반영 예정)된 값 이하는 무시한다.
    if (lastSentReadCursorRef.current != null && chatId <= lastSentReadCursorRef.current) return;

    // 다른 방의 cursor가 기존 pending에 섞이면 안 된다 — 방 전환 시 호출 측이 resetReadReceipt()를 먼저 호출하므로
    // 정상 흐름에서는 발생하지 않아야 하는 경로다.
    if (pendingRoomIdRef.current !== null && pendingRoomIdRef.current !== chatRoomId) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[useReadReceipt] scheduleReadUpTo: pending room과 다른 room의 cursor를 무시했습니다.",
          { pendingRoomId: pendingRoomIdRef.current, incomingRoomId: chatRoomId }
        );
      }
      return;
    }

    if (pendingRoomIdRef.current === chatRoomId && chatId <= pendingReadCursorRef.current) return;

    pendingRoomIdRef.current = chatRoomId;
    pendingReadCursorRef.current = chatId;

    const now = Date.now();
    const elapsed = lastSentAtRef.current == null ? Infinity : now - lastSentAtRef.current;

    if (elapsed >= READ_UP_TO_THROTTLE_MS) {
      flushPendingRead(chatRoomId);
      return;
    }

    if (trailingTimerRef.current == null) {
      armTrailingTimer(READ_UP_TO_THROTTLE_MS - elapsed);
    }
    // 이미 trailing timer가 있다면 재시작하지 않는다 — pending은 위에서 이미 최신값으로 갱신됨
  }, [flushPendingRead, armTrailingTimer]);

  // pending과 trailing timer만 정리한다. lastSentReadCursorRef/lastSentAtRef/memberLastReadRef는 건드리지 않는다.
  // 같은 방을 유지한 채 blur/hidden/disconnect가 발생할 때 사용한다. 반복 호출해도 안전하다(idempotent).
  const discardPendingRead = useCallback(() => {
    cancelTrailingTimer();
    pendingRoomIdRef.current = null;
    pendingReadCursorRef.current = null;
  }, [cancelTrailingTimer]);

  // READ_EVENT의 멤버별 stale/역행 판단을 수행한다. stale/중복(current <= lastProcessed)이면 null을 반환한다.
  // effectivePrevious는 memberLastReadRef를 갱신하기 "전"의 lastProcessed로 계산해야 한다
  // (먼저 덮어쓰면 항상 previous==current가 되어 이벤트가 무력화된다).
  const resolveApplicableReadEvent = useCallback((event) => {
    const lastProcessed = memberLastReadRef.current[event.memberId] ?? null;
    if (lastProcessed !== null && event.currentLastReadChatId <= lastProcessed) return null;

    let effectivePrevious;
    if (lastProcessed === null) {
      effectivePrevious = event.previousLastReadChatId;
    } else if (event.previousLastReadChatId === null) {
      effectivePrevious = lastProcessed;
    } else {
      effectivePrevious = Math.max(event.previousLastReadChatId, lastProcessed);
    }

    memberLastReadRef.current[event.memberId] = event.currentLastReadChatId;
    return { ...event, previousLastReadChatId: effectivePrevious };
  }, []);

  // 같은 batch에 동일 memberId가 여러 번 있으면 병합한다 — 그대로 순서대로 적용하면
  // 겹치는 (previous, current] 범위가 messages에 중복 반영될 수 있다.
  const selectApplicableReadEvents = useCallback((reads) => {
    if (!Array.isArray(reads)) return [];

    const mergedByMemberId = new Map();

    for (const read of reads) {
      if (read == null) continue;
      const { memberId, currentLastReadChatId } = read;
      if (memberId == null || currentLastReadChatId == null) continue;
      const previousLastReadChatId = read.previousLastReadChatId ?? null;

      const existing = mergedByMemberId.get(memberId);
      if (existing == null) {
        mergedByMemberId.set(memberId, { memberId, previousLastReadChatId, currentLastReadChatId });
        continue;
      }

      const mergedPrevious =
        existing.previousLastReadChatId === null || previousLastReadChatId === null
          ? null
          : Math.min(existing.previousLastReadChatId, previousLastReadChatId);
      const mergedCurrent = Math.max(existing.currentLastReadChatId, currentLastReadChatId);
      mergedByMemberId.set(memberId, {
        memberId,
        previousLastReadChatId: mergedPrevious,
        currentLastReadChatId: mergedCurrent,
      });
    }

    const applicable = [];
    for (const event of mergedByMemberId.values()) {
      const resolved = resolveApplicableReadEvent(event);
      if (resolved !== null) {
        applicable.push(resolved);
      }
    }
    return applicable;
  }, [resolveApplicableReadEvent]);

  // 방 전환/재연결 시 READ lifecycle 전체를 초기화한다.
  const resetReadReceipt = useCallback(() => {
    memberLastReadRef.current = {};
    discardPendingRead();
    lastSentReadCursorRef.current = null;
    lastSentAtRef.current = null;
  }, [discardPendingRead]);

  useEffect(() => {
    return () => {
      cancelTrailingTimer();
    };
  }, [cancelTrailingTimer]);

  return {
    scheduleReadUpTo,
    flushPendingRead,
    discardPendingRead,
    resetReadReceipt,
    resolveApplicableReadEvent,
    selectApplicableReadEvents,
  };
}
