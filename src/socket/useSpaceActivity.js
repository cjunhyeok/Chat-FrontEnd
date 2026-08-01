import { useEffect, useRef, useCallback } from "react";

/**
 * ROOM_ACTIVE / ROOM_INACTIVE 이벤트 전송을 담당하는 훅.
 *
 * 정책:
 * - ROOM_ACTIVE  : window focus + document visible 복구 시에만 전송
 * - ROOM_INACTIVE: window blur / document hidden / 방 선택 해제 시 전송
 *
 * 핵심 원칙: activeSpaceIdRef는 전송 결정과 동시에(전송 호출 이전에) 갱신한다.
 * 이렇게 해야 어떤 코드가 ref를 읽더라도 전송 의도와 일치하는 상태를 본다.
 */
export function useSpaceActivity({ selectedSpaceId, connected, sendRoomActive, sendRoomInactive, onActivate, onBeforeInactive }) {
  // document가 현재 보이는 상태인지 (다른 탭으로 이동하면 false)
  const isDocumentVisibleRef = useRef(!document.hidden);
  // window가 현재 포커스된 상태인지 (Alt+Tab 등으로 앱 전환하면 false)
  const isWindowFocusedRef = useRef(document.hasFocus());

  // FE가 "방이 active 상태"라고 판단하는 기준 ref.
  // ROOM_ACTIVE 전송 결정 직전에 spaceId로 설정.
  // ROOM_INACTIVE 전송 결정 직전에 null로 설정.
  // 이 ref가 null이면 focus/visible 복구 시 ROOM_ACTIVE를 전송한다.
  const activeSpaceIdRef = useRef(null);

  // useCallback 내부에서 최신값 참조용 ref
  const selectedSpaceIdRef = useRef(selectedSpaceId);
  const connectedRef = useRef(connected);
  // ChatPage가 매 렌더마다 새 함수를 넘겨도 이벤트 리스너/콜백을 재등록하지 않도록 ref로 최신 콜백만 동기화한다
  const onActivateRef = useRef(onActivate);
  // inactive로 전환되기 직전(ROOM_INACTIVE 전송/activeSpaceIdRef 해제 이전)에 호출된다.
  // READ cursor 상태는 이 hook이 알지 못하므로, 처리 책임은 전적으로 ChatPage가 주입하는 콜백에 위임한다.
  const onBeforeInactiveRef = useRef(onBeforeInactive);

  useEffect(() => { selectedSpaceIdRef.current = selectedSpaceId; }, [selectedSpaceId]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { onActivateRef.current = onActivate; }, [onActivate]);
  useEffect(() => { onBeforeInactiveRef.current = onBeforeInactive; }, [onBeforeInactive]);

  /**
   * 현재 창 상태(visible + focused)를 기준으로 ACTIVE/INACTIVE를 동기화한다.
   * blur, focus, visibilitychange 이벤트에서 모두 이 함수를 호출한다.
   *
   * ref를 전송 호출 이전에 먼저 갱신한다.
   * → 중복 이벤트(blur+visibilitychange 동시)가 와도 1회만 전송된다.
   * → 어떤 코드가 전송 직후 ref를 읽어도 이미 올바른 상태다.
   */
  const evaluateAndSync = useCallback(() => {
    const spaceId = selectedSpaceIdRef.current;

    // active 조건: 연결됨 AND 방 선택됨 AND 문서 보임 AND 창 포커스됨
    const shouldBeActive =
      connectedRef.current &&
      spaceId !== null &&
      isDocumentVisibleRef.current &&
      isWindowFocusedRef.current;

    if (shouldBeActive) {
      // active가 되어야 하는데 아직 이 방이 active가 아닐 때만 전송
      if (activeSpaceIdRef.current !== spaceId) {
        // ref를 먼저 갱신한 뒤 전송 → 전송 후 읽는 코드도 일관된 상태 확인
        activeSpaceIdRef.current = spaceId;
        sendRoomActive(spaceId);
        // inactive → active로 실제 전환된 순간에만 호출 (이미 active였다면 이 분기에 들어오지 않음)
        onActivateRef.current?.(spaceId);
      }
    } else {
      // inactive가 되어야 하는데 현재 active로 표시된 방이 있을 때만 전송
      const spaceToDeactivate = activeSpaceIdRef.current;
      if (spaceToDeactivate !== null) {
        // 같은 spaceToDeactivate !== null 가드 안에 있으므로 blur+visibilitychange가 연속 발생해도 1회만 호출된다.
        // 콜백에서 예외가 나도 activity 상태 해제와 ROOM_INACTIVE 전송은 반드시 이어져야 하므로 try/finally로 감싼다.
        try {
          onBeforeInactiveRef.current?.(spaceToDeactivate);
        } finally {
          // ref를 먼저 null로 갱신한 뒤 전송 → 전송 후 focus가 와도 null 상태에서 ROOM_ACTIVE 전송
          activeSpaceIdRef.current = null;
          sendRoomInactive(spaceToDeactivate);
        }
      }
    }
  }, [sendRoomActive, sendRoomInactive]);

  /**
   * ENTER_ROOM을 전송한 직후 ChatPage에서 반드시 호출한다.
   *
   * ENTER_ROOM이 백엔드에서 해당 방을 자동으로 activate하므로,
   * 여기서는 ROOM_ACTIVE를 보내지 않고 ref를 먼저 spaceId로 갱신한다.
   * 창이 blur/hidden 상태라면 ref를 null로 되돌리고 ROOM_INACTIVE를 전송한다.
   */
  const notifyEntered = useCallback((spaceId) => {
    // 미연결 상태에서는 동기화 불필요 (재연결 후 ENTER_ROOM이 다시 전송됨)
    if (!connectedRef.current) return;

    // ENTER_ROOM이 백엔드 activate를 처리했으므로 ref를 먼저 spaceId로 갱신
    activeSpaceIdRef.current = spaceId;

    // 창이 blur/hidden 상태라면 즉시 ref를 null로 되돌린 뒤 ROOM_INACTIVE 전송
    if (!isDocumentVisibleRef.current || !isWindowFocusedRef.current) {
      activeSpaceIdRef.current = null;
      sendRoomInactive(spaceId);
      return;
    }

    // 되돌리지 않고 최종적으로 active로 남는 경우에만 호출 (reconnect 후 재확정 포함)
    onActivateRef.current?.(spaceId);
  }, [sendRoomInactive]);

  // selectedSpaceId가 null이 되면 ROOM_INACTIVE 전송 후 ref null로 초기화
  // null → spaceId 전환(방 선택/전환)은 notifyEntered에서 처리한다.
  useEffect(() => {
    if (!connected) return;

    if (selectedSpaceId === null) {
      const spaceToDeactivate = activeSpaceIdRef.current;
      if (spaceToDeactivate !== null) {
        // ref를 먼저 null로 갱신한 뒤 전송
        activeSpaceIdRef.current = null;
        sendRoomInactive(spaceToDeactivate);
      }
    }
  }, [selectedSpaceId, connected, sendRoomInactive]);

  // 연결 끊김 시 ref 초기화 (서버가 세션을 cleanup하므로 FE도 동기화)
  // 재연결 후 ENTER_ROOM 재전송은 ChatPage의 reconnect useEffect가 담당한다.
  useEffect(() => {
    if (!connected) {
      activeSpaceIdRef.current = null;
    }
  }, [connected]);

  // window blur/focus, document visibility 이벤트 등록 및 해제
  useEffect(() => {
    const onBlur = () => {
      isWindowFocusedRef.current = false;
      evaluateAndSync();
    };
    const onFocus = () => {
      isWindowFocusedRef.current = true;
      evaluateAndSync();
    };
    // 탭 전환, 다른 앱으로 이동 등에서 발생
    const onVisibilityChange = () => {
      isDocumentVisibleRef.current = !document.hidden;
      evaluateAndSync();
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [evaluateAndSync]);

  // 현재 spaceId가 active 상태인지 읽기 전용으로 노출 (ref 자체는 캡슐화)
  const isSpaceActive = useCallback(
    (spaceId) => activeSpaceIdRef.current === spaceId,
    []
  );

  return { notifyEntered, isSpaceActive };
}
