import { act, renderHook, waitFor } from "@testing-library/react";
import { useSpaces } from "../../hooks/useSpaces";
import { getSpaces } from "../../api/spaceApi";

// 팩토리 없는 자동 목(jest.mock("../../api/spaceApi"))은 mock 형태를 추론하기 위해 실제 spaceApi.js를 로드하고,
// 그 과정에서 axios의 ESM 진입점까지 require되어 "Cannot use import statement outside a module"로 실패한다.
// useSpaces.js가 참조하는 getSpaces 하나만 명시적으로 mock해 실제 모듈을 아예 로드하지 않도록 한다.
jest.mock("../../api/spaceApi", () => ({
  getSpaces: jest.fn(),
}));

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  // mockResolvedValueOnce/mockRejectedValueOnce/mockReturnValueOnce로 쌓인 큐가 다음 테스트로 새지 않도록
  // mockClear보다 강한 mockReset(큐+구현 모두 제거)을 사용한다.
  jest.resetAllMocks();
});

// 마운트 → 초기 자동 조회 완료 대기 → 호출 기록 초기화까지 공통으로 처리한다.
async function renderLoaded(initialData = [], selectedSpaceId = null) {
  getSpaces.mockResolvedValueOnce({ data: initialData });

  const view = renderHook(
    ({ selectedSpaceId }) => useSpaces(selectedSpaceId),
    { initialProps: { selectedSpaceId } }
  );

  await waitFor(() => expect(view.result.current.spacesLoaded).toBe(true));
  getSpaces.mockClear();

  return view;
}

describe("initial load", () => {
  test("마운트 시 getSpaces가 정확히 1회 호출된다", async () => {
    getSpaces.mockResolvedValueOnce({ data: [] });

    const { result } = renderHook(() => useSpaces(null));

    await waitFor(() => expect(result.current.spacesLoaded).toBe(true));
    expect(getSpaces).toHaveBeenCalledTimes(1);
  });

  test("초기 조회 성공 시 spaces/spacesError/selectedSpace가 반영된다", async () => {
    const data = [
      { chatRoomId: 1, title: "A", createdDate: "2026-01-01T00:00:00" },
      { chatRoomId: 2, title: "B", createdDate: "2026-01-02T00:00:00" },
    ];
    getSpaces.mockResolvedValueOnce({ data });

    const { result } = renderHook(() => useSpaces(2));

    await waitFor(() => expect(result.current.spacesLoaded).toBe(true));

    expect(result.current.spaces.map((s) => s.chatRoomId).sort()).toEqual([1, 2]);
    expect(result.current.spacesError).toBe(false);
    expect(result.current.selectedSpace.chatRoomId).toBe(2);
  });

  test("초기 조회 실패 시 spacesError=true이고 예외가 테스트 밖으로 전파되지 않는다", async () => {
    getSpaces.mockRejectedValueOnce(new Error("network error"));

    const { result } = renderHook(() => useSpaces(null));

    await waitFor(() => expect(result.current.spacesLoaded).toBe(true));

    expect(result.current.spacesError).toBe(true);
    expect(result.current.spaces).toEqual([]);
  });
});

describe("refreshSpaces", () => {
  test("성공 시 병합된 배열을 resolve하고 state에도 동일하게 반영된다", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", lastChatId: 1, createdDate: "2026-01-01T00:00:00" },
    ]);

    getSpaces.mockResolvedValueOnce({
      data: [{ chatRoomId: 1, title: "A", lastChatId: 2, createdDate: "2026-01-02T00:00:00" }],
    });

    let resolved;
    await act(async () => {
      resolved = await result.current.refreshSpaces();
    });

    expect(resolved[0].lastChatId).toBe(2);
    expect(result.current.spaces[0].lastChatId).toBe(2);
    expect(result.current.spacesError).toBe(false);
  });

  test("실패 시 reject 없이 null을 resolve하고 spacesError=true이며 기존 spaces는 유지된다", async () => {
    const initial = [{ chatRoomId: 1, title: "A", createdDate: "2026-01-01T00:00:00" }];
    const { result } = await renderLoaded(initial);

    getSpaces.mockRejectedValueOnce(new Error("boom"));

    let resolved;
    await act(async () => {
      resolved = await result.current.refreshSpaces();
    });

    expect(resolved).toBeNull();
    expect(result.current.spacesError).toBe(true);
    expect(result.current.spaces.map((s) => s.chatRoomId)).toEqual([1]);
  });

  test("진행 중인 refresh가 있으면 새 GET을 발행하지 않는다(single-flight)", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", createdDate: "2026-01-01T00:00:00" },
    ]);

    const deferred = createDeferred();
    getSpaces.mockReturnValueOnce(deferred.promise);
    // 진행 중 재호출은 trailing을 예약하므로, resolve 이후 자동으로 발생할 두 번째 GET도 미리 준비해둔다.
    getSpaces.mockResolvedValueOnce({
      data: [{ chatRoomId: 1, title: "A", lastChatId: 1, createdDate: "2026-01-02T00:00:00" }],
    });

    let firstCall;
    act(() => {
      firstCall = result.current.refreshSpaces();
    });
    act(() => {
      result.current.refreshSpaces();
    });

    // 핵심 검증: API 호출 횟수가 여전히 1회인지만 확인한다(Promise 참조 동일성은 검증하지 않는다).
    expect(getSpaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({
        data: [{ chatRoomId: 1, title: "A", lastChatId: 0, createdDate: "2026-01-01T00:00:00" }],
      });
      await firstCall;
    });

    await waitFor(() => expect(getSpaces).toHaveBeenCalledTimes(2));
  });

  test("진행 중 여러 번 추가 호출해도 trailing GET은 완료 후 정확히 1회만 실행되고, 이후 refresh는 다시 정상 동작한다", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", lastChatId: 1, createdDate: "2026-01-01T00:00:00" },
    ]);

    const deferred1 = createDeferred();
    getSpaces.mockReturnValueOnce(deferred1.promise);

    let firstPromise;
    act(() => {
      firstPromise = result.current.refreshSpaces();
    });

    // 진행 중 여러 번 추가 호출 — trailing은 1회로 합쳐져야 한다.
    act(() => {
      result.current.refreshSpaces();
      result.current.refreshSpaces();
      result.current.refreshSpaces();
    });

    expect(getSpaces).toHaveBeenCalledTimes(1);

    const deferred2 = createDeferred();
    getSpaces.mockReturnValueOnce(deferred2.promise);

    let firstResolvedValue;
    await act(async () => {
      deferred1.resolve({
        data: [{ chatRoomId: 1, title: "A", lastChatId: 2, createdDate: "2026-01-02T00:00:00" }],
      });
      firstResolvedValue = await firstPromise;
    });

    // trailing GET이 정확히 1회 새로 시작됐는지 확인한다.
    await waitFor(() => expect(getSpaces).toHaveBeenCalledTimes(2));

    // 최초 호출자의 Promise는 trailing GET의 결과를 기다리지 않고 자신의 GET 결과로만 resolve된다(현재 구현 기준).
    expect(firstResolvedValue[0].lastChatId).toBe(2);

    await act(async () => {
      deferred2.resolve({
        data: [{ chatRoomId: 1, title: "A", lastChatId: 3, createdDate: "2026-01-03T00:00:00" }],
      });
      await deferred2.promise;
    });

    await waitFor(() => expect(result.current.spaces[0].lastChatId).toBe(3));

    // trailing 완료 후에는 진행 중인 refresh가 없으므로 새 refresh가 다시 정상적으로 GET을 실행한다.
    getSpaces.mockResolvedValueOnce({
      data: [{ chatRoomId: 1, title: "A", lastChatId: 4, createdDate: "2026-01-04T00:00:00" }],
    });
    await act(async () => {
      await result.current.refreshSpaces();
    });
    expect(getSpaces).toHaveBeenCalledTimes(3);
  });
});

describe("space mutations", () => {
  test("patchSpace가 대상 chatRoomId의 필드만 병합하고, 다른 Space와 존재하지 않는 id는 영향받지 않는다", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", unreadMessageCount: 3 },
      { chatRoomId: 2, title: "B", unreadMessageCount: 5 },
    ]);

    act(() => {
      result.current.patchSpace(1, { unreadMessageCount: 0 });
    });

    const spaceOne = result.current.spaces.find((s) => s.chatRoomId === 1);
    const spaceTwo = result.current.spaces.find((s) => s.chatRoomId === 2);
    expect(spaceOne).toEqual({ chatRoomId: 1, title: "A", unreadMessageCount: 0 });
    expect(spaceTwo).toEqual({ chatRoomId: 2, title: "B", unreadMessageCount: 5 });

    act(() => {
      result.current.patchSpace(999, { unreadMessageCount: 99 });
    });

    expect(result.current.spaces).toEqual([
      { chatRoomId: 1, title: "A", unreadMessageCount: 0 },
      { chatRoomId: 2, title: "B", unreadMessageCount: 5 },
    ]);
  });

  test("removeSpace가 대상 chatRoomId만 제거하고, 존재하지 않는 id는 목록에 영향을 주지 않는다", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A" },
      { chatRoomId: 2, title: "B" },
    ]);

    act(() => {
      result.current.removeSpace(1);
    });
    expect(result.current.spaces).toEqual([{ chatRoomId: 2, title: "B" }]);

    act(() => {
      result.current.removeSpace(999);
    });
    expect(result.current.spaces).toEqual([{ chatRoomId: 2, title: "B" }]);
  });

  test("selectedSpace가 selectedSpaceId 변경에 따라 갱신되고, 일치하는 Space가 없으면 undefined다", async () => {
    const { result, rerender } = await renderLoaded(
      [
        { chatRoomId: 1, title: "A" },
        { chatRoomId: 2, title: "B" },
      ],
      1
    );

    expect(result.current.selectedSpace.chatRoomId).toBe(1);

    rerender({ selectedSpaceId: 2 });
    expect(result.current.selectedSpace.chatRoomId).toBe(2);

    rerender({ selectedSpaceId: 999 });
    expect(result.current.selectedSpace).toBeUndefined();
  });
});

describe("snapshot and realtime merge", () => {
  test("applyMessageSummary 호출이 spaces에 반영된다(훅 연결 확인, 세부 정책은 spaceState.test.js가 검증)", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", lastChatId: 10, createdDate: "2026-01-01T00:00:00" },
    ]);

    act(() => {
      result.current.applyMessageSummary(
        { chatRoomId: 1, lastMessage: "hi", lastChatId: 11, createdDate: "2026-01-02T00:00:00" },
        false
      );
    });

    expect(result.current.spaces[0].lastChatId).toBe(11);
    expect(result.current.spaces[0].lastMessage).toBe("hi");
  });

  test("refresh GET 진행 중 반영된 더 최신 local summary를 늦게 도착한 REST snapshot이 덮어쓰지 않는다", async () => {
    const { result } = await renderLoaded([
      { chatRoomId: 1, title: "A", lastMessage: "old", lastChatId: 10, createdDate: "2026-01-01T00:00:00" },
    ]);

    const deferred = createDeferred();
    getSpaces.mockReturnValueOnce(deferred.promise);

    let refreshPromise;
    act(() => {
      refreshPromise = result.current.refreshSpaces();
    });

    // GET 응답이 도착하기 전에 더 최신 local summary(lastChatId=12)가 먼저 반영된다.
    act(() => {
      result.current.applyMessageSummary(
        { chatRoomId: 1, lastMessage: "local newest", lastChatId: 12, createdDate: "2026-01-03T00:00:00" },
        false
      );
    });

    // 늦게 도착한 REST 응답은 그보다 stale한 lastChatId=11을 담고 있다.
    await act(async () => {
      deferred.resolve({
        data: [
          { chatRoomId: 1, title: "A", lastMessage: "from server", lastChatId: 11, createdDate: "2026-01-02T00:00:00" },
        ],
      });
      await refreshPromise;
    });

    expect(result.current.spaces[0].lastChatId).toBe(12);
    expect(result.current.spaces[0].lastMessage).toBe("local newest");
  });
});
