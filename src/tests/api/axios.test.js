jest.mock("axios", () => jest.requireActual("axios/dist/node/axios.cjs"));

import axiosInstance from "../../api/axios";

describe("axios response interceptor — 401 처리", () => {
  let originalAdapter;
  let originalLocationDescriptor;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("memberId", "1");
    sessionStorage.setItem("nickname", "tester");

    originalAdapter = axiosInstance.defaults.adapter;

    originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost/chat" },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    axiosInstance.defaults.adapter = originalAdapter;
    Object.defineProperty(window, "location", originalLocationDescriptor);
  });

  test("401 응답을 받으면 인증 정보를 제거하고 로그인 화면으로 이동한 뒤 원래 오류를 전달한다", async () => {
    const unauthorizedError = {
      response: { status: 401 },
      config: {},
      isAxiosError: true,
    };

    axiosInstance.defaults.adapter = () => Promise.reject(unauthorizedError);

    await expect(axiosInstance.get("/api/chat/rooms")).rejects.toBe(unauthorizedError);

    expect(sessionStorage.getItem("memberId")).toBeNull();
    expect(sessionStorage.getItem("nickname")).toBeNull();

    expect(window.location.href).toBe("/");
  });

  test("401이 아닌 오류는 인증 정보와 현재 경로를 유지한 채 원래 오류를 전달한다", async () => {
    const serverError = {
      response: { status: 500 },
      config: {},
      isAxiosError: true,
    };

    axiosInstance.defaults.adapter = () => Promise.reject(serverError);

    await expect(axiosInstance.get("/api/chat/rooms")).rejects.toBe(serverError);

    expect(sessionStorage.getItem("memberId")).toBe("1");
    expect(sessionStorage.getItem("nickname")).toBe("tester");
    expect(window.location.href).toBe("http://localhost/chat");
  });
});
