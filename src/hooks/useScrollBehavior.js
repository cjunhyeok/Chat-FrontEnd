import { useEffect, useLayoutEffect, useRef, useState } from "react";

export default function useScrollBehavior({
  messages,
  loading,
  lastReadMessageId,
  isLoadingMore,
  hasMore,
  onLoadMore,
  currentUserId,
}) {
  const scrollContainerRef = useRef(null);
  const bottomRef = useRef(null);
  const readMarkerRef = useRef(null);
  const scrolledRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);
  const prevScrollHeightRef = useRef(0);
  const isLoadingMoreRef = useRef(isLoadingMore);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const checkIsAtBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  const checkIsAtTop = () => {
    const el = scrollContainerRef.current;
    if (!el) return false;
    return el.scrollTop < 50;
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setNewMessageCount(0);
  };

  const handleScroll = () => {
    if (checkIsAtBottom()) {
      setNewMessageCount(0);
    }
    if (checkIsAtTop() && hasMore && !isLoadingMore) {
      onLoadMore();
    }
  };

  // scrollIntoView는 flex layout 변화(textarea 높이 축소 등)나 scroll anchoring과 겹치면 결과 위치가 흔들릴 수 있어,
  // 컨테이너의 scrollTop을 최대값으로 직접 지정하는 편이 더 안정적이다.
  const scrollToBottomImmediately = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  };

  // 내가 보낸 메시지 추가 시 paint 전에 bottom을 고정한다 — pending row 추가와 입력창 높이 축소가 같은 commit에서
  // 일어나면 scrollTop이 clamp되어 "위로 튄" 프레임이 그려질 수 있고, useEffect(paint 이후)로는 보정이 늦다.
  // 최초 진입 처리는 아래 useEffect가 전담하므로 scrolledRef.current가 true인 이후에만 동작한다.
  useLayoutEffect(() => {
    if (loading) return;
    if (!scrolledRef.current) return;
    if (messages.length <= prevMessagesLengthRef.current) return;
    if (isLoadingMoreRef.current) return;

    const newMessages = messages.slice(prevMessagesLengthRef.current);
    const isMySent =
      currentUserId != null &&
      newMessages.some((m) => m.senderId === currentUserId);
    if (!isMySent) return;

    prevMessagesLengthRef.current = messages.length;
    scrollToBottomImmediately();
    setNewMessageCount(0);
  }, [loading, messages, currentUserId]);

  useEffect(() => {
    if (loading) {
      scrolledRef.current = false;
      prevMessagesLengthRef.current = 0;
      setNewMessageCount(0);
      return;
    }
    if (messages.length === 0) return;

    if (!scrolledRef.current) {
      scrolledRef.current = true;
      prevMessagesLengthRef.current = messages.length;
      if (lastReadMessageId !== null && readMarkerRef.current) {
        readMarkerRef.current.scrollIntoView({ behavior: "instant" });
      } else {
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
      }
    } else if (messages.length > prevMessagesLengthRef.current) {
      // 내가 보낸 메시지는 위 useLayoutEffect가 이미 처리하고 prevMessagesLengthRef를 갱신했으므로,
      // 여기 도달하는 경우는 항상 다른 사용자가 보낸 메시지다.
      const newCount = messages.length - prevMessagesLengthRef.current;
      prevMessagesLengthRef.current = messages.length;
      if (!isLoadingMoreRef.current) {
        if (checkIsAtBottom()) {
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        } else {
          setNewMessageCount((prev) => prev + newCount);
        }
      }
    }
  }, [loading, messages, lastReadMessageId, currentUserId]);

  // 다른 effect에서 최신값을 동기적으로 참조하기 위해 ref로 동기화한다.
  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore]);

  // load-more 시작 시 scrollHeight 캡처, 완료 시 스크롤 위치 복원
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (isLoadingMore) {
      prevScrollHeightRef.current = el.scrollHeight;
    } else if (prevScrollHeightRef.current > 0) {
      const diff = el.scrollHeight - prevScrollHeightRef.current;
      if (diff > 0) el.scrollTop += diff;
      prevScrollHeightRef.current = 0;
    }
  }, [isLoadingMore]);

  return {
    scrollContainerRef,
    bottomRef,
    readMarkerRef,
    newMessageCount,
    handleScroll,
    scrollToBottom,
  };
}
