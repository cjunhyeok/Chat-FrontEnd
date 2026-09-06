import { useCallback, useEffect, useRef, useState } from "react";

export function useRoomEntry({ connected, selectedSpaceId, sendEnterRoom }) {
  // ENTER_ROOM_ACK 수신 시에만 설정된다(전송 시점이 아님).
  const [enteredSpaceId, setEnteredSpaceId] = useState(null);
  // wsError(4초 자동 소멸)와 독립적으로 유지된다.
  const [enterRoomFailed, setEnterRoomFailed] = useState(false);
  const [enterRoomRetryable, setEnterRoomRetryable] = useState(true);

  const enteredSpaceIdRef = useRef(null);
  // ACK/ERROR 매칭은 이 ref가 아닌 호출 측(ChatPage)의 selectedSpaceIdRef로 판단한다.
  const pendingEnterRoomSpaceIdRef = useRef(null);

  // ref 비교라 더블클릭에도 안전하며, timeout 없이 ACK/ERROR가 올 때까지 대기한다.
  const triggerEnterRoom = useCallback(
    (spaceId) => {
      if (pendingEnterRoomSpaceIdRef.current === spaceId) return;

      pendingEnterRoomSpaceIdRef.current = spaceId;
      sendEnterRoom(spaceId);
    },
    [sendEnterRoom]
  );

  useEffect(() => {
    if (!connected) return;

    if (selectedSpaceId === null) {
      pendingEnterRoomSpaceIdRef.current = null;
      enteredSpaceIdRef.current = null;
      setEnteredSpaceId(null);
      setEnterRoomFailed(false);
      setEnterRoomRetryable(true);
      return;
    }

    if (enteredSpaceIdRef.current === selectedSpaceId) return;

    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
    triggerEnterRoom(selectedSpaceId);
  }, [connected, selectedSpaceId, triggerEnterRoom]);

  useEffect(() => {
    if (!connected) {
      pendingEnterRoomSpaceIdRef.current = null;
      enteredSpaceIdRef.current = null;
      setEnteredSpaceId(null);
      setEnterRoomFailed(false);
      setEnterRoomRetryable(true);
    }
  }, [connected]);

  // 자동 재시도·백오프는 없다.
  const retryEnterRoom = useCallback(() => {
    if (!selectedSpaceId || !connected) return;
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
    triggerEnterRoom(selectedSpaceId);
  }, [selectedSpaceId, connected, triggerEnterRoom]);

  // chatRoomId 일치 검증은 호출 측(ChatPage)이 마친 뒤 호출한다.
  const handleEnterRoomAck = useCallback((chatRoomId) => {
    // pending 불일치와 무관하게 이후 ACK 반영은 그대로 진행된다.
    if (pendingEnterRoomSpaceIdRef.current === chatRoomId) {
      pendingEnterRoomSpaceIdRef.current = null;
    }
    enteredSpaceIdRef.current = chatRoomId;
    setEnteredSpaceId(chatRoomId);
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
  }, []);

  // requestType/stale 판단과 이후 처리(wsError 등)는 호출 측(ChatPage)이 담당한다.
  const handleEnterRoomError = useCallback((chatRoomId, errorCode) => {
    if (pendingEnterRoomSpaceIdRef.current === chatRoomId) {
      pendingEnterRoomSpaceIdRef.current = null;
    }
    enteredSpaceIdRef.current = null;
    setEnteredSpaceId(null);
    setEnterRoomFailed(true);
    // INVALID_REQUEST(FE 요청 오류)·UNAUTHORIZED(로그인 만료)는 재시도해도 성공 가능성이 낮아 버튼을 숨긴다.
    setEnterRoomRetryable(
      errorCode !== "INVALID_REQUEST" &&
      errorCode !== "UNAUTHORIZED"
    );
  }, []);

  // 전체 초기화 대신 enterRoomFailed만 되돌려야 하는 곳(예: 접근 불가 확정 후)에서 사용한다.
  const clearEnterRoomFailure = useCallback(() => {
    setEnterRoomFailed(false);
  }, []);

  return {
    enteredSpaceId,
    enterRoomFailed,
    enterRoomRetryable,
    retryEnterRoom,
    handleEnterRoomAck,
    handleEnterRoomError,
    clearEnterRoomFailure,
  };
}
