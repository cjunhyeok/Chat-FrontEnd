import { useCallback, useEffect, useRef, useState } from "react";

// ENTER_ROOM 전송, 입장 완료/실패 상태, 재시도, 연결 종료 후 초기화만 담당한다.
// selectedSpaceId 자체의 변경, ROOM_ACTIVE/INACTIVE(notifyEntered), Space 목록 재조회(refreshSpaces),
// 공용 wsError 배너, 메시지 History는 호출 측(ChatPage)이 소유한다.
export function useRoomEntry({ connected, selectedSpaceId, sendEnterRoom }) {
  // 서버가 ENTER_ROOM_ACK로 입장을 확인한 selectedSpaceId (enteredSpaceIdRef의 상태 버전). ENTER_ROOM 전송만으로는 설정되지 않는다.
  const [enteredSpaceId, setEnteredSpaceId] = useState(null);
  // 현재 selectedSpaceId에 대한 ENTER_ROOM이 ERROR로 실패해 재시도 UI를 보여줘야 하는지. wsError(4초 후 자동 소멸)와 독립적으로 유지된다.
  const [enterRoomFailed, setEnterRoomFailed] = useState(false);
  // enterRoomFailed=true인 실패 중에서 "다시 보내면 성공할 가능성이 있는지". INVALID_REQUEST(FE 요청/프로토콜 오류)처럼 같은 요청을 반복해도 성공할 수 없는 경우에만 false가 된다.
  const [enterRoomRetryable, setEnterRoomRetryable] = useState(true);

  // ENTER_ROOM_ACK를 수신해 서버가 입장을 확인한 selectedSpaceId
  const enteredSpaceIdRef = useRef(null);
  // ENTER_ROOM을 보냈지만 아직 ACK/ERROR 응답을 받지 못한 spaceId. 중복 ENTER_ROOM 전송 방지용으로만 쓰인다.
  // ACK/ERROR 매칭은 이 ref가 아니라 호출 측(ChatPage)의 selectedSpaceIdRef와의 비교로만 판단한다 (timeout이 없으므로 "이미 해제된 pending"이라는 개념이 없다)
  const pendingEnterRoomSpaceIdRef = useRef(null);

  // ENTER_ROOM 전송 + 대기 상태 기록의 단일 진입점. 최초 전송(effect)과 사용자의 명시적 재시도(retryEnterRoom)가 공유한다.
  // 같은 spaceId로 이미 보내고 ACK/ERROR를 기다리는 중이면(ref는 동기로 즉시 반영되므로 더블클릭/중복 호출에도 안전) 재전송하지 않는다.
  // timeout 없이 ACK 또는 ERROR가 올 때까지 synchronizing 상태를 유지한다.
  const triggerEnterRoom = useCallback(
    (spaceId) => {
      if (pendingEnterRoomSpaceIdRef.current === spaceId) return;

      pendingEnterRoomSpaceIdRef.current = spaceId;
      sendEnterRoom(spaceId);
    },
    [sendEnterRoom]
  );

  // ENTER_ROOM 전송: 응답(ACK/ERROR)을 기다리지 않고 전송만 수행한다.
  // enteredSpaceId/enteredSpaceIdRef는 ENTER_ROOM_ACK 수신 시에만 설정된다.
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

    // 중복 전송 방지는 triggerEnterRoom 내부 가드가 단일하게 담당한다
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

  // ENTER_ROOM 실패 후 사용자가 명시적으로 재시도할 때만 호출된다. 자동 재시도/타이머/백오프는 없다.
  const retryEnterRoom = useCallback(() => {
    if (!selectedSpaceId || !connected) return;
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
    triggerEnterRoom(selectedSpaceId);
  }, [selectedSpaceId, connected, triggerEnterRoom]);

  // 유효한 ENTER_ROOM_ACK에 대한 상태 반영만 수행한다.
  // data.chatRoomId === selectedSpaceIdRef.current 판단과 notifyEntered 호출은 호출 측(ChatPage)이 담당한다.
  const handleEnterRoomAck = useCallback((chatRoomId) => {
    // 같은 spaceId로 대기 중이던 pending이면 dedup 가드를 해제한다 (일치하지 않아도 ACK 반영 자체는 막지 않는다)
    if (pendingEnterRoomSpaceIdRef.current === chatRoomId) {
      pendingEnterRoomSpaceIdRef.current = null;
    }
    enteredSpaceIdRef.current = chatRoomId;
    setEnteredSpaceId(chatRoomId);
    setEnterRoomFailed(false);
    setEnterRoomRetryable(true);
  }, []);

  // 유효한 ENTER_ROOM ERROR에 대한 상태 반영만 수행한다.
  // requestType/stale 판단, wsError 표시, ROOM_NOT_FOUND/FORBIDDEN 후속 처리는 호출 측(ChatPage)이 담당한다.
  const handleEnterRoomError = useCallback((chatRoomId, errorCode) => {
    // 같은 spaceId로 대기 중이던 pending이면 dedup 가드를 해제한다
    if (pendingEnterRoomSpaceIdRef.current === chatRoomId) {
      pendingEnterRoomSpaceIdRef.current = null;
    }
    enteredSpaceIdRef.current = null;
    setEnteredSpaceId(null);
    // 재시도 UI 노출 — 사용자가 명시적으로 재시도하기 전까지 유지된다 (자동 재시도 없음)
    setEnterRoomFailed(true);
    // INVALID_REQUEST(FE 요청/프로토콜 오류), UNAUTHORIZED(로그인 만료)는 같은 요청을 다시 보내도
    // 성공할 가능성이 낮으므로 재시도 버튼을 숨긴다
    setEnterRoomRetryable(
      errorCode !== "INVALID_REQUEST" &&
      errorCode !== "UNAUTHORIZED"
    );
  }, []);

  // ROOM_NOT_FOUND/FORBIDDEN 확정(더 이상 접근 불가) 등, 전체 초기화가 아니라 enterRoomFailed만 되돌려야 하는 지점에서 사용한다.
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
