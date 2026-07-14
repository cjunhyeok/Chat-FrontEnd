/**
 * Space 배열을 createdDate 최신순으로 정렬한 새 배열을 반환한다.
 *
 * - 원본 배열은 변경하지 않는다(복사 후 정렬).
 * - createdDate가 없는 항목은 뒤로 보낸다.
 *
 * @param {Array<{createdDate?: string}>} spaces
 * @returns {Array}
 */
export const sortSpaces = (spaces) =>
  [...spaces].sort((a, b) => {
    if (!a.createdDate && !b.createdDate) return 0;
    if (!a.createdDate) return 1;
    if (!b.createdDate) return -1;
    return new Date(b.createdDate) - new Date(a.createdDate);
  });

/**
 * incoming lastChatId가 current lastChatId 대비 중복/역전인지 판단한다.
 *
 * 정책:
 * - incoming이 없으면 적용하지 않는다(stale로 간주).
 * - current가 없으면 incoming을 최신으로 간주한다(stale 아님).
 * - 그 외에는 incoming <= current일 때 중복/역전으로 간주한다.
 *
 * @param {number|null|undefined} currentLastChatId
 * @param {number|null|undefined} incomingLastChatId
 * @returns {boolean}
 */
const isStaleOrDuplicateLastChatId = (currentLastChatId, incomingLastChatId) => {
  if (incomingLastChatId == null) return true;
  if (currentLastChatId == null) return false;
  return incomingLastChatId <= currentLastChatId;
};

/**
 * ROOM_MESSAGE_SUMMARY_UPDATED 이벤트를 spaces에 적용한 새 배열을 반환한다.
 *
 * 정책:
 * - event.chatRoomId와 일치하는 Space가 없으면 spaces를 그대로 반환한다(신규 Space 발견은 SPACE_INVITED 책임).
 * - event.lastChatId가 현재 Space의 lastChatId보다 최신이 아니면(중복/역전) 무시하고 spaces를 그대로 반환한다.
 * - 최신 이벤트이면 lastMessage/lastChatId/createdDate만 갱신하고 title 등 다른 필드는 유지한다.
 * - isActiveSpace가 true면 unreadMessageCount를 0으로, false면 기존 값(없으면 0) + 1로 갱신한다.
 *   (active 여부는 호출부가 useSpaceActivity의 isSpaceActive(spaceId) 판정을 그대로 전달한다 — 단순 selected 여부가 아니다.)
 * - 적용 후 sortSpaces로 재정렬한다.
 *
 * @param {Array} spaces
 * @param {{ chatRoomId: number, lastChatId: number, lastMessage: string, createdDate: string }} event
 * @param {boolean} isActiveSpace
 * @returns {Array}
 */
export const applyRoomMessageSummary = (spaces, event, isActiveSpace) => {
  const target = spaces.find((s) => s.chatRoomId === event.chatRoomId);
  if (!target) {
    return spaces;
  }

  if (isStaleOrDuplicateLastChatId(target.lastChatId, event.lastChatId)) {
    return spaces;
  }

  const nextUnreadMessageCount = isActiveSpace
    ? 0
    : Number(target.unreadMessageCount ?? 0) + 1;

  const updated = spaces.map((s) =>
    s.chatRoomId === event.chatRoomId
      ? {
          ...s,
          lastMessage: event.lastMessage,
          lastChatId: event.lastChatId,
          createdDate: event.createdDate,
          unreadMessageCount: nextUnreadMessageCount,
        }
      : s
  );

  return sortSpaces(updated);
};

const localSummaryIsNewer = (snapshotLastChatId, localLastChatId) => {
  if (localLastChatId == null) return false;
  if (snapshotLastChatId == null) return true;
  return localLastChatId > snapshotLastChatId;
};

export const mergeSpaceSnapshot = (currentSpaces, snapshotSpaces) => {
  const currentByChatRoomId = new Map(
    currentSpaces.map((s) => [s.chatRoomId, s])
  );

  const merged = snapshotSpaces.map((snapshotSpace) => {
    const localSpace = currentByChatRoomId.get(snapshotSpace.chatRoomId);
    if (!localSpace) {
      return snapshotSpace;
    }

    if (localSummaryIsNewer(snapshotSpace.lastChatId, localSpace.lastChatId)) {
      return {
        ...snapshotSpace,
        lastMessage: localSpace.lastMessage,
        lastChatId: localSpace.lastChatId,
        createdDate: localSpace.createdDate,
        unreadMessageCount: localSpace.unreadMessageCount,
      };
    }

    return snapshotSpace;
  });

  return sortSpaces(merged);
};
