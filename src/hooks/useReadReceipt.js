import { useCallback, useEffect, useRef } from "react";

// READ_UP_TO 전송 정책 — 1초 leading + throttle + trailing.
// 첫 cursor는 즉시 전송하고, 이후 1초 동안 도착하는 cursor는 가장 큰 값만 pending으로 모아
// 1초가 되는 시점에 한 번만 전송한다.
const READ_UP_TO_THROTTLE_MS = 1000;

// READ_UP_TO cursor 누적/전송과 READ_EVENT 멤버별 stale 판단만 담당한다.
// chatRoomId/selectedSpaceId 일치 검사, messages 반영(useRoomHistory), ROOM_ACTIVE/INACTIVE 전송(useSpaceActivity)은
// 호출 측(ChatPage)이 소유한다.
//
// Orbit는 한 시점에 하나의 선택된 방에 대한 READ 상태만 관리하며 방 전환 시 resetReadReceipt()로 전체 초기화하므로,
// lastSentReadCursorRef/pendingReadCursorRef에는 방을 구분하는 별도 ref(lastSentRoomIdRef)를 두지 않는다.
export function useReadReceipt({ sendReadUpTo, isSpaceActive }) {
  // 현재 room에서 멤버별로 마지막으로 반영한 read cursor (READ_EVENT stale/역전 판단용)
  const memberLastReadRef = useRef({});

  // 아직 서버로 보내지 못한 read cursor. 항상 pendingReadCursorRef와 한 쌍으로 관리한다
  // (pending 없음 → 둘 다 null / pending 있음 → 둘 다 값 존재).
  const pendingRoomIdRef = useRef(null);
  const pendingReadCursorRef = useRef(null);

  // 마지막으로 성공 전송된 read cursor와 그 시각 — throttle 창의 기준점
  const lastSentReadCursorRef = useRef(null);
  const lastSentAtRef = useRef(null);

  // 예약된 1회성 trailing timer id (setTimeout). 최대 1개만 존재한다.
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

  // 현재 pending을 best-effort로 즉시 한 번 전송한다.
  // expectedRoomId가 주어지면 pendingRoomIdRef와 일치할 때만 전송한다(다른 방 pending을 실수로 보내지 않기 위함).
  // isSpaceActive를 여기서 재검사하지 않는다 — 방 전환/inactive 전환 "직전"에도 이 함수가 호출되므로,
  // 그 경계에서 activity 상태가 이미 바뀌어 있어도 flush 자체가 차단되면 안 된다.
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
    if (trailingTimerRef.current != null) return; // 이미 예약됨 — 재예약하지 않는다
    trailingTimerRef.current = setTimeout(() => {
      trailingTimerRef.current = null;
      // 예약 당시 cursor를 closure로 들고 있지 않고, 발화 시점에 ref에서 최신 pending을 읽는다.
      flushPendingRead();
    }, remainingMs);
  }, [flushPendingRead]);

  // active 상태인 현재 room에서만 read cursor를 누적하고, leading+throttle+trailing 정책에 따라 전송을 예약한다.
  const scheduleReadUpTo = useCallback((chatRoomId, chatId) => {
    if (chatRoomId == null || chatId == null) return;
    if (!isSpaceActiveRef.current(chatRoomId)) return;

    // 이미 서버에 반영된(또는 반영 예정으로 확정된) cursor 이하는 무시한다
    if (lastSentReadCursorRef.current != null && chatId <= lastSentReadCursorRef.current) return;

    // 다른 방의 cursor가 기존 pending에 섞이면 안 된다 — 조용히 덮어쓰지 않고 무시한다.
    // 정상 흐름에서는 방 전환 시 호출 측이 반드시 resetReadReceipt()를 먼저 호출하므로 발생하지 않아야 하는 경로다.
    if (pendingRoomIdRef.current !== null && pendingRoomIdRef.current !== chatRoomId) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[useReadReceipt] scheduleReadUpTo: pending room과 다른 room의 cursor를 무시했습니다.",
          { pendingRoomId: pendingRoomIdRef.current, incomingRoomId: chatRoomId }
        );
      }
      return;
    }

    // 같은 방에서 이미 pending으로 잡힌 값 이하라면 갱신할 것이 없다
    if (pendingRoomIdRef.current === chatRoomId && chatId <= pendingReadCursorRef.current) return;

    pendingRoomIdRef.current = chatRoomId;
    pendingReadCursorRef.current = chatId;

    const now = Date.now();
    const elapsed = lastSentAtRef.current == null ? Infinity : now - lastSentAtRef.current;

    if (elapsed >= READ_UP_TO_THROTTLE_MS) {
      // 마지막 성공 전송 후 1초 이상 지났거나 아직 한 번도 보낸 적 없음 — leading edge로 즉시 전송
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

  // READ_EVENT의 멤버별 stale/역전 판단 + 이미 반영한 범위와 겹치는 부분 제거(effectivePrevious 보정)를 수행한다.
  // chatRoomId 일치 검사, messages 반영(applyReadEvent), lastReadMessageId 갱신은 호출 측(ChatPage/useRoomHistory)이 담당한다.
  // - stale/중복(current <= lastProcessed)이면 null을 반환해 적용 대상에서 제외한다.
  // - 적용 가능하면 previousLastReadChatId를 effectivePrevious로 보정한 이벤트를 반환한다.
  //   effectivePrevious는 반드시 memberLastReadRef를 갱신하기 "전"의 lastProcessed로 계산해야 한다
  //   (먼저 덮어쓰면 항상 previous==current가 되어 모든 이벤트가 빈 범위로 무력화된다).
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

  // READ_EVENT_BATCH(및 단건 READ_EVENT를 배열 1개로 감싼 값)에서 실제로 적용해야 할 read만 골라낸다.
  // - malformed item(null, memberId/currentLastReadChatId 없음)은 조용히 무시한다.
  // - 같은 batch 안에 동일 memberId가 여러 번 있으면 서버 accumulator와 동일한 정책으로 병합한다
  //   (병합하지 않고 각 item을 그대로 순서대로 적용하면 겹치는 (previous, current] 범위가 messages에 중복 반영될 수 있다).
  // - 멤버별 stale/역행 판단 및 겹치는 범위 보정은 resolveApplicableReadEvent를 그대로 재사용한다(로직 복제 없음).
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

  // 방 전환 / 재연결 시 READ lifecycle 전체를 초기화한다. discardPendingRead()를 재사용해 중복을 줄인다.
  const resetReadReceipt = useCallback(() => {
    memberLastReadRef.current = {};
    discardPendingRead();
    lastSentReadCursorRef.current = null;
    lastSentAtRef.current = null;
  }, [discardPendingRead]);

  // 컴포넌트 unmount 시 예약된 trailing timer를 정리한다
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
