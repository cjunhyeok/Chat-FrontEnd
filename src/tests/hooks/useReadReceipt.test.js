import { renderHook, act } from "@testing-library/react";
import { useReadReceipt } from "../../hooks/useReadReceipt";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function setup({ isActive = true } = {}) {
  const sendReadUpTo = jest.fn();
  const isSpaceActive = jest.fn(() => isActive);
  const { result, unmount } = renderHook(() =>
    useReadReceipt({ sendReadUpTo, isSpaceActive })
  );
  return { sendReadUpTo, isSpaceActive, result, unmount };
}

describe("scheduleReadUpTo", () => {
  test("chatId가 null이면 전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, null);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("active Space가 아니면 전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup({ isActive: false });

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("800ms 전에는 전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(799);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });

  test("마지막 schedule 호출 후 800ms가 지나면 전송한다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
    expect(sendReadUpTo).toHaveBeenCalledWith(1, 10);
  });

  test("연속 호출 시 가장 큰 cursor로 한 번만 전송한다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
      result.current.scheduleReadUpTo(1, 15);
      result.current.scheduleReadUpTo(1, 12);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
    expect(sendReadUpTo).toHaveBeenCalledWith(1, 15);
  });

  test("연속 호출마다 타이머가 다시 시작되는 trailing debounce다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(400);
    });
    act(() => {
      result.current.scheduleReadUpTo(1, 11);
    });
    act(() => {
      jest.advanceTimersByTime(400);
    });

    // 최초 호출 기준으로는 800ms가 지났지만 중간 재호출로 타이머가 재시작되어 아직 전송되지 않아야 한다
    expect(sendReadUpTo).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(400);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
    expect(sendReadUpTo).toHaveBeenCalledWith(1, 11);
  });

  test("이미 전송한 cursor 이하 값은 재전송하지 않는다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(1);
  });

  test("더 큰 cursor는 새 debounce 주기 후 전송된다", () => {
    const { sendReadUpTo, result } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(sendReadUpTo).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.scheduleReadUpTo(1, 20);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).toHaveBeenCalledTimes(2);
    expect(sendReadUpTo).toHaveBeenLastCalledWith(1, 20);
  });

  test("unmount 시 예약된 전송이 취소된다", () => {
    const { sendReadUpTo, result, unmount } = setup();

    act(() => {
      result.current.scheduleReadUpTo(1, 10);
    });
    unmount();
    act(() => {
      jest.advanceTimersByTime(800);
    });

    expect(sendReadUpTo).not.toHaveBeenCalled();
  });
});

describe("shouldApplyReadEvent", () => {
  test("멤버의 첫 이벤트는 true를 반환한다", () => {
    const { result } = setup();

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    expect(applied).toBe(true);
  });

  test("동일 cursor는 false를 반환한다", () => {
    const { result } = setup();

    act(() => {
      result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    expect(applied).toBe(false);
  });

  test("더 낮은 cursor는 false를 반환한다", () => {
    const { result } = setup();

    act(() => {
      result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 3 });
    });

    expect(applied).toBe(false);
  });

  test("더 높은 cursor는 true를 반환한다", () => {
    const { result } = setup();

    act(() => {
      result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 8 });
    });

    expect(applied).toBe(true);
  });

  test("서로 다른 memberId는 독립적으로 판단한다", () => {
    const { result } = setup();

    act(() => {
      result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
    });

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 2, currentLastReadChatId: 5 });
    });

    expect(applied).toBe(true);
  });

  test("resetReadReceipt 이후에는 이전 cursor 상태가 제거된다", () => {
    const { result } = setup();

    act(() => {
      result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 5 });
      result.current.resetReadReceipt();
    });

    let applied;
    act(() => {
      applied = result.current.shouldApplyReadEvent({ memberId: 1, currentLastReadChatId: 3 });
    });

    // reset 후에는 이전 cursor(5)가 사라졌으므로 더 낮은 cursor(3)도 다시 true로 판단된다
    expect(applied).toBe(true);
  });
});
