import { renderHook, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "../../context/AuthContext";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("AuthContext — 인증 상태 복원", () => {
  test("memberId와 nickname이 모두 있으면 인증 정보를 복원한다", () => {
    sessionStorage.setItem("memberId", "1");
    sessionStorage.setItem("nickname", "tester");

    const { result } = renderHook(() => useAuth(), {
      wrapper: AuthProvider,
    });

    expect(result.current.auth).toEqual({
      memberId: 1,
      nickname: "tester",
    });
  });

  test.each([
    ["1", null],
    [null, "tester"],
    [null, null],
  ])(
    "memberId=%s, nickname=%s이면 비로그인 상태로 시작한다",
    (memberId, nickname) => {
      if (memberId !== null) {
        sessionStorage.setItem("memberId", memberId);
      }

      if (nickname !== null) {
        sessionStorage.setItem("nickname", nickname);
      }

      const { result } = renderHook(() => useAuth(), {
        wrapper: AuthProvider,
      });

      expect(result.current.auth).toBeNull();
    }
  );
});

describe("AuthContext — signin", () => {
  test("signin은 인증 상태와 sessionStorage를 함께 갱신한다", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: AuthProvider,
    });

    expect(result.current.auth).toBeNull();

    const memberId = 1;
    const nickname = "tester";

    act(() => {
      result.current.signin(memberId, nickname);
    });

    expect(result.current.auth).toEqual({
      memberId,
      nickname,
    });
    expect(sessionStorage.getItem("memberId")).toBe("1");
    expect(sessionStorage.getItem("nickname")).toBe(nickname);
  });
});

describe("AuthContext — signout", () => {
  test("signout은 인증 상태와 sessionStorage를 함께 제거한다", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: AuthProvider,
    });

    const memberId = 1;
    const nickname = "tester";

    act(() => {
      result.current.signin(memberId, nickname);
    });

    expect(result.current.auth).toEqual({
      memberId,
      nickname,
    });
    expect(sessionStorage.getItem("memberId")).toBe("1");
    expect(sessionStorage.getItem("nickname")).toBe(nickname);

    act(() => {
      result.current.signout();
    });

    expect(result.current.auth).toBeNull();
    expect(sessionStorage.getItem("memberId")).toBeNull();
    expect(sessionStorage.getItem("nickname")).toBeNull();
  });
});

describe("AuthContext — updateNickname", () => {
  test("updateNickname은 memberId를 유지하고 nickname 상태와 sessionStorage를 갱신한다", () => {
    const { result } = renderHook(() => useAuth(), {
      wrapper: AuthProvider,
    });

    const memberId = 1;
    const originalNickname = "tester";
    const newNickname = "newNickname";

    act(() => {
      result.current.signin(memberId, originalNickname);
    });

    expect(result.current.auth).toEqual({
      memberId,
      nickname: originalNickname,
    });
    expect(sessionStorage.getItem("memberId")).toBe("1");
    expect(sessionStorage.getItem("nickname")).toBe(originalNickname);

    act(() => {
      result.current.updateNickname(newNickname);
    });

    expect(result.current.auth).toEqual({
      memberId,
      nickname: newNickname,
    });
    expect(sessionStorage.getItem("memberId")).toBe("1");
    expect(sessionStorage.getItem("nickname")).toBe(newNickname);
  });
});
