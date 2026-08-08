import { renderHook, act } from "@testing-library/react";
import { useReadReceipt } from "../../hooks/useReadReceipt";
import { applyReadEvents } from "../../utils/messageState";

const THROTTLE_MS = 1000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function setup({ isActive = true, sendResult = true } = {}) {
  const sendReadUpTo = jest.fn(() => sendResult);
  const isSpaceActive = jest.fn(() => isActive);
  const { result, unmount } = renderHook(() =>
    useReadReceipt({ sendReadUpTo, isSpaceActive })
  );
  return { sendReadUpTo, isSpaceActive, result, unmount };
}

describe("scheduleReadUpTo — leading edge", () => {
  test("첫 cursor는 즉시 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
    expect(sendReadUpTo).toHaveBeenCalledWith(1, 100);
  });

  test("chatId 또는 chatRoomId가 없으면 아무 것도 하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, null);
      result.current.scheduleReadUpTo(null, 100);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("active Space가 아니면 전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup({ isActive: false });

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("throttle 창(1초)이 끝난 뒤의 cursor는 다시 즉시(leading) 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    act(() => {
      result.current.scheduleReadUpTo(1, 200);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 200);
  });
});

describe("scheduleReadUpTo — throttle 구간 안의 연속 cursor", () => {
  test("예시 시나리오: t=0 즉시 전송, t=100/300/800의 cursor는 pending으로만 쌓이고 t=1000에 최댓값이 한 번 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // t=0
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
    expect(sendReadUpTo).toHaveBeenCalledWith(1, 100);

    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 101); // t=100
    });
    act(() => {
      jest.advanceTimersByTime(200);
      result.current.scheduleReadUpTo(1, 102); // t=300
    });
    act(() => {
      jest.advanceTimersByTime(500);
      result.current.scheduleReadUpTo(1, 105); // t=800
    });

    // 아직 1초가 안 지났으므로 leading 전송 1번뿐이어야 한다
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(200); // t=1000
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 105);
  });

  test("이미 trailing timer가 예약되어 있으면 추가 cursor가 와도 timer를 재시작하지 않는다 (debounce와 달리 지연이 무기한 늘어나지 않는다)", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // t=0, leading 즉시 전송
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(900);
      result.current.scheduleReadUpTo(1, 101); // t=900, trailing timer 예약 (남은 100ms)
    });

    act(() => {
      jest.advanceTimersByTime(900);
      result.current.scheduleReadUpTo(1, 102); // t=1800 — 만약 timer가 재시작됐다면 여기서 다시 1초를 기다려야 한다
    });

    // trailing timer가 재시작되지 않았다면, t=900에 예약된 timer가 t=1000에 이미 발화했어야 한다
    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenNthCalledWith(2, 1, 101);
  });

  test("이벤트가 계속 들어와도(간격 < 1초) debounce처럼 무기한 지연되지 않고 1초마다 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 1); // t=0, leading
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    // 200ms 간격으로 9번 더 호출 (t=200 ~ t=1800), 매번 이전 cursor보다 큰 값
    for (let i = 2; i <= 10; i += 1) {
      act(() => {
        jest.advanceTimersByTime(200);
        result.current.scheduleReadUpTo(1, i);
      });
    }

    // leading(t=0) + trailing(t=1000 부근 최댓값 1번) = 최소 2번은 전송되어야 한다 (무기한 지연 아님)
    expect(sendReadUpTo.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("scheduleReadUpTo — 단조성", () => {
  test("마지막 성공 전송 cursor 이하 값은 무시한다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // 즉시 전송, lastSent=100
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // 동일값 — 무시
      result.current.scheduleReadUpTo(1, 50); // 더 작은 값 — 무시
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
  });

  test("현재 pending cursor 이하 값은 무시된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // leading 전송, throttle 구간 시작
    });
    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // pending=200
    });
    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 150); // pending(200)보다 작음 — 무시돼야 함
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 200);
  });

  test("다른 roomId의 cursor는 기존 pending을 덮어쓰지 않고 무시된다", () => {
    const { sendReadUpTo, result } = setup();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // leading 전송, throttle 구간 시작
    });
    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // room 1 pending=200
    });
    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(2, 999); // 다른 방 — 무시돼야 함
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    // room 1의 pending(200)만 전송되고, room 2(999)는 전송되지 않는다
    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 200);
    expect(sendReadUpTo).not.toHaveBeenCalledWith(2, 999);

    warnSpy.mockRestore();
  });
});

describe("전송 실패", () => {
  test("전송 실패 시 lastSent cursor/time이 갱신되지 않아, 더 큰 cursor가 오면 다시 시도된다", () => {
    const { sendReadUpTo, result } = setup({ sendResult: false });

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // 즉시 시도하지만 실패
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
      // lastSent가 갱신되지 않았으므로(=여전히 null) elapsed는 Infinity로 계산되어 다시 leading으로 시도된다.
      // 실패한 cursor(100)와 정확히 같은 값이 아니라 더 큰 값(101)으로 검증한다 — CHAT_MESSAGE의 chatId는
      // 항상 증가하므로 실제 재시도는 이 경로(새 메시지 도착)로 일어난다.
      result.current.scheduleReadUpTo(1, 101);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 101);
  });

  test("전송 실패 시 pending이 유지되고, 자동 재시도 timer는 생성되지 않는다", () => {
    const { sendReadUpTo, result } = setup({ sendResult: false });

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // 즉시 시도 실패, pending은 유지된 채로 남는다
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS * 5); // 자동 재시도 timer가 있다면 여기서 추가 호출이 발생했을 것
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
  });

  test("trailing timer 콜백에서 전송이 실패해도 pending은 유지된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // leading 성공
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    sendReadUpTo.mockReturnValue(false);

    act(() => {
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // trailing 예약
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS); // trailing 발화 — 실패
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 200);

    // 실패했으므로 pending(200)이 남아 있어야 하고, flushPendingRead()로 재시도하면 다시 전송을 시도해야 한다
    sendReadUpTo.mockReturnValue(true);
    act(() => {
      result.current.flushPendingRead();
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(3);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 200);
  });
});

describe("flushPendingRead", () => {
  test("pending이 없으면 아무 작업도 하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.flushPendingRead();
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("expectedRoomId가 pendingRoomId와 다르면 전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // leading 즉시 전송
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // pending=200
    });
    sendReadUpTo.mockClear();

    act(() => {
      result.current.flushPendingRead(999); // 다른 방 id — 전송하지 않아야 함
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("expectedRoomId가 일치하면 즉시 전송한다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200);
    });
    sendReadUpTo.mockClear();

    act(() => {
      result.current.flushPendingRead(1);
    });

    expect(sendReadUpTo).toHaveBeenCalledWith(1, 200);
  });
});

describe("discardPendingRead", () => {
  test("pending과 trailing timer를 정리하고, 이후 timer가 발화해도 전송되지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // leading 전송
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // trailing 예약
    });
    sendReadUpTo.mockClear();

    act(() => {
      result.current.discardPendingRead();
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("lastSentReadCursorRef 기반 동작(단조성)은 discardPendingRead 이후에도 유지된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100); // lastSent=100
    });
    act(() => {
      result.current.discardPendingRead();
    });

    sendReadUpTo.mockClear();
    act(() => {
      result.current.scheduleReadUpTo(1, 100); // lastSent(100) 이하 — 여전히 무시돼야 함
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("반복 호출해도 안전하다(idempotent)", () => {
    const { result } = setup();

    expect(() => {
      act(() => {
        result.current.discardPendingRead();
        result.current.discardPendingRead();
      });
    }).not.toThrow();
  });
});

describe("resetReadReceipt", () => {
  test("lastSentReadCursorRef까지 초기화해 이전보다 작은 cursor도 다시 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
    });
    act(() => {
      result.current.resetReadReceipt();
    });

    sendReadUpTo.mockClear();
    act(() => {
      result.current.scheduleReadUpTo(1, 50); // reset 전이었다면 lastSent(100) 이하라 무시됐을 값
    });

    expect(sendReadUpTo).toHaveBeenCalledWith(1, 50);
  });

  test("trailing timer도 함께 취소한다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // trailing 예약
    });
    sendReadUpTo.mockClear();

    act(() => {
      result.current.resetReadReceipt();
    });
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });
});

describe("unmount", () => {
  test("unmount 시 예약된 trailing timer가 취소되어 전송되지 않는다", () => {
    const { sendReadUpTo, result, unmount } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 100);
      jest.advanceTimersByTime(100);
      result.current.scheduleReadUpTo(1, 200); // trailing 예약
    });
    sendReadUpTo.mockClear();

    unmount();
    act(() => {
      jest.advanceTimersByTime(THROTTLE_MS);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });
});

describe("resolveApplicableReadEvent", () => {
  test("멤버의 첫 이벤트는 그대로(previous 보정 없이) 반환된다", () => {
    const { result } = setup();

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1,
        previousLastReadChatId: 90,
        currentLastReadChatId: 99,
      });
    });

    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 99 });
  });

  test("동일 cursor는 null을 반환한다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
    });

    expect(resolved).toBeNull();
  });

  test("더 낮은 cursor(역순 이벤트)는 null을 반환한다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 99,
      });
    });

    expect(resolved).toBeNull();
  });

  test("정상 순차 이벤트는 previous가 그대로 유지된다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 99,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100,
      });
    });

    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100 });
  });

  test("겹치는 이벤트는 previous가 이미 반영한 cursor(lastProcessed)로 보정된다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 80, currentLastReadChatId: 99,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100,
      });
    });

    // 원본 (90,100]이 아니라, 이미 반영된 99까지를 하한으로 하는 (99,100]으로 보정되어야 한다
    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100 });
  });

  test("event.previous가 null이고 lastProcessed도 null이면 previous는 null로 유지된다", () => {
    const { result } = setup();

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 100,
      });
    });

    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 100 });
  });

  test("event.previous가 null이고 lastProcessed가 존재하면 previous는 lastProcessed로 보정된다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 99,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 100,
      });
    });

    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100 });
  });

  test("서로 다른 memberId는 독립적으로 판단한다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 2, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
    });

    expect(resolved).toEqual({ memberId: 2, previousLastReadChatId: 0, currentLastReadChatId: 5 });
  });

  test("discardPendingRead 이후에는 memberLastReadRef가 보존된다 (blur/hidden 정책)", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
      result.current.discardPendingRead();
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 3,
      });
    });

    // discardPendingRead는 memberLastReadRef를 건드리지 않으므로 여전히 낮은 cursor(3)는 null이어야 한다
    expect(resolved).toBeNull();
  });

  test("resetReadReceipt 이후에는 이전 cursor 상태가 제거된다", () => {
    const { result } = setup();

    act(() => {
      result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 5,
      });
      result.current.resetReadReceipt();
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 3,
      });
    });

    // reset 후에는 이전 cursor(5)가 사라졌으므로 더 낮은 cursor(3)도 다시 적용 가능으로 판단된다
    expect(resolved).toEqual({ memberId: 1, previousLastReadChatId: 0, currentLastReadChatId: 3 });
  });
});

describe("selectApplicableReadEvents", () => {
  test("단건 item 배열([data])을 그대로 적용 가능한 이벤트로 반환한다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
      ]);
    });

    expect(applicable).toEqual([
      { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
    ]);
  });

  test("같은 방의 서로 다른 member는 모두 적용 가능한 이벤트로 반환된다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
        { memberId: 2, previousLastReadChatId: null, currentLastReadChatId: 5 },
      ]);
    });

    expect(applicable).toHaveLength(2);
    expect(applicable.map((e) => e.memberId).sort()).toEqual([1, 2]);
  });

  test("previousLastReadChatId가 null인 최초 읽음 이벤트도 정상 처리된다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 5 },
      ]);
    });

    expect(applicable[0]).toEqual({ memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 5 });
  });

  test("같은 batch 안에 동일 memberId가 여러 번 있으면 가장 큰 current, previous는 null 우선/최솟값으로 병합된다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
        { memberId: 1, previousLastReadChatId: 105, currentLastReadChatId: 120 },
      ]);
    });

    expect(applicable).toEqual([
      { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 120 },
    ]);
  });

  test("병합 시 previous 중 하나라도 null이면 병합된 previous도 null이다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 105 },
        { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
      ]);
    });

    expect(applicable[0].previousLastReadChatId).toBeNull();
    expect(applicable[0].currentLastReadChatId).toBe(110);
  });

  test("이미 반영된 cursor보다 작거나 같은 current는 제외된다(단조성 유지)", () => {
    const { result } = setup();

    act(() => {
      result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 100, currentLastReadChatId: 110 },
      ]);
    });

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 105, currentLastReadChatId: 110 }, // 동일 current
      ]);
    });
    expect(applicable).toHaveLength(0);

    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 105, currentLastReadChatId: 108 }, // 더 낮은 current
      ]);
    });
    expect(applicable).toHaveLength(0);
  });

  test("memberId 또는 currentLastReadChatId가 없는 malformed item은 무시하고 나머지 유효 item은 처리한다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        null,
        { previousLastReadChatId: 100, currentLastReadChatId: 110 }, // memberId 없음
        { memberId: 2, previousLastReadChatId: 100 }, // currentLastReadChatId 없음
        { memberId: 3, previousLastReadChatId: null, currentLastReadChatId: 50 }, // 유효
      ]);
    });

    expect(applicable).toEqual([
      { memberId: 3, previousLastReadChatId: null, currentLastReadChatId: 50 },
    ]);
  });

  test("reads가 배열이 아니면 빈 배열을 반환한다", () => {
    const { result } = setup();

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents(null);
    });

    expect(applicable).toEqual([]);
  });

  test("resolveApplicableReadEvent와 memberLastReadRef 상태를 공유한다 — batch 처리 후 단건 READ_EVENT도 동일하게 stale 판단된다", () => {
    const { result } = setup();

    act(() => {
      result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: null, currentLastReadChatId: 110 },
      ]);
    });

    let resolved;
    act(() => {
      resolved = result.current.resolveApplicableReadEvent({
        memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100,
      });
    });

    expect(resolved).toBeNull();
  });

  test("겹치는 이벤트는 previous가 이미 반영한 cursor로 보정되어 반환된다", () => {
    const { result } = setup();

    act(() => {
      result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 80, currentLastReadChatId: 99 },
      ]);
    });

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100 },
      ]);
    });

    // 원본 previous(90)가 아니라 이미 반영된 99로 보정된 (99,100]만 남아야 한다
    expect(applicable).toEqual([
      { memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100 },
    ]);
  });

  test("서로 다른 호출(batch)에 걸쳐 겹치는 경우에도 두 번째 호출은 보정된 범위만 반환한다", () => {
    const { result } = setup();

    let firstCall;
    act(() => {
      firstCall = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 99 },
      ]);
    });
    expect(firstCall).toEqual([
      { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 99 },
    ]);

    let secondCall;
    act(() => {
      secondCall = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100 },
      ]);
    });

    expect(secondCall).toEqual([
      { memberId: 1, previousLastReadChatId: 99, currentLastReadChatId: 100 },
    ]);
  });

  test("같은 batch 안의 동일 memberId merge(min(previous)/max(current))는 겹침 보정 이전에 그대로 유지된다", () => {
    const { result } = setup();

    act(() => {
      result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 95 },
      ]);
    });

    let applicable;
    act(() => {
      applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 80, currentLastReadChatId: 99 },
        { memberId: 1, previousLastReadChatId: 85, currentLastReadChatId: 110 },
      ]);
    });

    // batch 내부 merge 결과는 (min(80,85)=80, max(99,110)=110) → (80,110]
    // 이어서 lastProcessed=95와 겹침 보정: effectivePrevious = max(80, 95) = 95 → (95,110]
    expect(applicable).toEqual([
      { memberId: 1, previousLastReadChatId: 95, currentLastReadChatId: 110 },
    ]);
  });

  test("겹치는 두 batch를 selectApplicableReadEvents → applyReadEvents로 연결해도 91~99는 한 번만, 100은 새로 감소한다", () => {
    const { result } = setup();

    let messages = [];
    for (let chatId = 91; chatId <= 100; chatId += 1) {
      messages.push({ chatId, senderId: 999, unreadMemberCount: 3 });
    }

    // 1차: READ_UP_TO(99) — (90,99] 반영, 91~99가 1회 감소
    act(() => {
      const applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 99 },
      ]);
      messages = applyReadEvents(messages, applicable);
    });

    for (let chatId = 91; chatId <= 99; chatId += 1) {
      expect(messages.find((m) => m.chatId === chatId).unreadMemberCount).toBe(2);
    }
    expect(messages.find((m) => m.chatId === 100).unreadMemberCount).toBe(3);

    // 2차: CHAT_MESSAGE(100) — stale previous(90)를 실은 (90,100] 이벤트가 뒤늦게 도착
    act(() => {
      const applicable = result.current.selectApplicableReadEvents([
        { memberId: 1, previousLastReadChatId: 90, currentLastReadChatId: 100 },
      ]);
      messages = applyReadEvents(messages, applicable);
    });

    // 91~99는 effectivePrevious 보정 덕분에 추가로 감소하지 않고 2를 유지해야 한다
    for (let chatId = 91; chatId <= 99; chatId += 1) {
      expect(messages.find((m) => m.chatId === chatId).unreadMemberCount).toBe(2);
    }
    // 100만 이번에 새로 1회 감소한다
    expect(messages.find((m) => m.chatId === 100).unreadMemberCount).toBe(2);
  });
});
