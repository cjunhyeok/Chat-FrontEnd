import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getSpaces } from "../api/spaceApi";
import { applyRoomMessageSummary, mergeSpaceSnapshot } from "../utils/spaceState";

export function useSpaces(selectedSpaceId) {
  const [spaces, setSpaces] = useState([]);
  const [spacesError, setSpacesError] = useState(false);
  const [spacesLoaded, setSpacesLoaded] = useState(false);

  // refreshSpaces가 병합 기준으로 삼는 최신 spaces 스냅샷.
  // WebSocket이 초기 GET보다 먼저 도착할 수 있으므로(연결 순서상 보장 없음) 항상 최신 spaces를 참조하도록 ref로 동기화한다.
  const spacesRef = useRef([]);
  useEffect(() => {
    spacesRef.current = spaces;
  }, [spaces]);

  useEffect(() => {
    getSpaces()
      .then((result) => {
        setSpaces((prev) => mergeSpaceSnapshot(prev, result.data ?? []));
        setSpacesError(false);
      })
      .catch(() => setSpacesError(true))
      .finally(() => setSpacesLoaded(true));
  }, []);

  // 진행 중인 refresh의 Promise. 중복 호출 시 새 GET 대신 이 Promise를 그대로 반환한다(single-flight).
  const refreshingRef = useRef(null);
  // 진행 중인 refresh가 끝난 뒤 한 번 더 refresh해야 하는지 여부.
  const refreshRequestedRef = useRef(false);

  // 새로 고침된(병합·정렬된) spaces 배열을 resolve하는 Promise를 반환한다.
  // 실패 시에도 reject하지 않고 null을 resolve한다 — 기존 fire-and-forget 호출부가 unhandled rejection 없이 그대로 동작하도록 하기 위함.
  const refreshSpaces = useCallback(() => {
    if (refreshingRef.current) {
      refreshRequestedRef.current = true;
      return refreshingRef.current;
    }

    const run = () =>
      getSpaces()
        .then((result) => {
          // GET 응답이 도착하기 전 더 최신 ROOM_MESSAGE_SUMMARY_UPDATED가 local에 반영됐을 수 있으므로
          // snapshot으로 무조건 교체하지 않고 mergeSpaceSnapshot으로 최신 local summary를 보존한다.
          const merged = mergeSpaceSnapshot(spacesRef.current, result.data ?? []);
          spacesRef.current = merged;
          setSpaces(merged);
          setSpacesError(false);
          return merged;
        })
        .catch(() => {
          setSpacesError(true);
          return null;
        })
        .finally(() => {
          if (refreshRequestedRef.current) {
            refreshRequestedRef.current = false;
            refreshingRef.current = run();
          } else {
            refreshingRef.current = null;
          }
        });

    refreshingRef.current = run();
    return refreshingRef.current;
  }, []);

  // ROOM_MESSAGE_SUMMARY_UPDATED 이벤트를 spaces에 적용한다(중복/역전 무시, unread 갱신, 재정렬은 applyRoomMessageSummary가 담당).
  // isActiveSpace는 호출부(ChatPage)가 useSpaceActivity의 isSpaceActive(spaceId) 판정을 넘겨준다.
  const applyMessageSummary = useCallback((event, isActiveSpace) => {
    setSpaces((prev) => applyRoomMessageSummary(prev, event, isActiveSpace));
  }, []);

  const removeSpace = useCallback((spaceId) => {
    setSpaces((prev) => prev.filter((r) => r.chatRoomId !== spaceId));
  }, []);

  const patchSpace = useCallback((spaceId, patch) => {
    setSpaces((prev) =>
      prev.map((r) => (r.chatRoomId === spaceId ? { ...r, ...patch } : r))
    );
  }, []);

  const selectedSpace = useMemo(
    () => spaces.find((r) => r.chatRoomId === selectedSpaceId),
    [spaces, selectedSpaceId]
  );

  return {
    spaces,
    spacesError,
    spacesLoaded,
    selectedSpace,
    refreshSpaces,
    applyMessageSummary,
    removeSpace,
    patchSpace,
  };
}
