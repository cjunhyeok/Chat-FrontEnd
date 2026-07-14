import { useState, useEffect, useCallback, useRef } from "react";
import { useResizablePanel } from "../../hooks/useResizablePanel";
import { getDiscussion, createDiscussion, getDiscussionMessages } from "../../api/discussionApi";
import { mergeDiscussionMessagesById } from "../../utils/messageState";
import { formatMessageTime } from "../../utils/formatTime";
import { useAuth } from "../../context/AuthContext";
import DiscussionMessageItem from "./DiscussionMessageItem";
import MessageContentRenderer from "./MessageContentRenderer";

export default function DiscussionPanel({ message, onClose, incomingDiscussionEvents, onConsumeDiscussionEvents, sendDiscussionMessage, connected }) {
  const { auth } = useAuth();
  const messageId = message.chatId;

  const { width, handleResizeStart } = useResizablePanel();

  const [status, setStatus] = useState("loading"); // "loading" | "not_found" | "error" | "loaded"
  const [discussion, setDiscussion] = useState(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [discussionMessages, setDiscussionMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);

  const [inputContent, setInputContent] = useState("");

  // 이미 append된 discussionMessageId를 추적해 중복 append를 방지한다.
  // 컴포넌트 마운트마다 초기화되므로 panel 재오픈 시 자동 리셋된다.
  const processedMessageIdsRef = useRef(new Set());
  const syncFetchIdRef = useRef(0);
  // getDiscussion/createDiscussion의 stale 응답 방어용. DiscussionPanel은 message prop만 바뀌어도
  // (리마운트 없이) 재사용되므로, 두 요청이 같은 discussion state를 쓰는 공유 카운터로 이전 messageId의
  // 늦은 응답이 현재 messageId의 state를 덮어쓰지 못하게 한다.
  const discussionRequestIdRef = useRef(0);
  const isComposingRef = useRef(false);
  // reconnect 감지용: null=초기 마운트, false=단절, true=연결
  const prevConnectedRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const shouldScrollRef = useRef(false);

  const loadDiscussion = useCallback(() => {
    const requestId = ++discussionRequestIdRef.current;
    setStatus("loading");
    setDiscussion(null);
    setCreateError(null);
    getDiscussion(messageId)
      .then((result) => {
        if (requestId !== discussionRequestIdRef.current) return;
        setDiscussion(result.data);
        setStatus("loaded");
      })
      .catch((err) => {
        if (requestId !== discussionRequestIdRef.current) return;
        if (err?.response?.status === 404) {
          setStatus("not_found");
        } else {
          setStatus("error");
        }
      });
  }, [messageId]);

  useEffect(() => { loadDiscussion(); }, [loadDiscussion]);

  const discussionId = discussion?.discussionId ?? null;

  // 서버 기준으로 메시지 목록을 replace하고 processedIds를 rebuild한다.
  // 초기 로드·reconnect re-sync 공통 사용. 성공 시 messagesError 해제.
  const syncDiscussionMessages = useCallback(async () => {
    if (!discussionId) return;
    const fetchId = ++syncFetchIdRef.current;
    const result = await getDiscussionMessages(discussionId);
    if (fetchId !== syncFetchIdRef.current) return;
    const messages = result.data ?? [];
    messages.forEach((m) => processedMessageIdsRef.current.add(m.discussionMessageId));
    setDiscussionMessages((prev) => mergeDiscussionMessagesById(prev, messages));
    setMessagesError(null);
  }, [discussionId]);

  // Queue에서 현재 discussionId와 일치하는 이벤트만 append한다.
  // 다른 discussionId 이벤트는 MVP 정책상 소비·폐기한다.
  // discussionMessageId 기준 중복 append를 processedMessageIdsRef로 방어한다.
  useEffect(() => {
    if (!incomingDiscussionEvents.length || !discussionId) return;

    const toAppend = incomingDiscussionEvents.filter(
      (e) =>
        e.discussionId === discussionId &&
        !processedMessageIdsRef.current.has(e.discussionMessageId)
    );

    // 처리 여부와 무관하게 queue에서 소비한다 (다른 discussion 이벤트 포함).
    onConsumeDiscussionEvents(incomingDiscussionEvents.map((e) => e.discussionMessageId));

    if (toAppend.length === 0) return;

    toAppend.forEach((e) => processedMessageIdsRef.current.add(e.discussionMessageId));
    if (toAppend.some((e) => e.senderId === auth.memberId)) {
      shouldScrollRef.current = true;
    }
    setDiscussionMessages((prev) => [...prev, ...toAppend]);
  }, [incomingDiscussionEvents, discussionId, onConsumeDiscussionEvents, auth.memberId]);

  useEffect(() => {
    if (!discussionId) {
      processedMessageIdsRef.current = new Set();
      setDiscussionMessages([]);
      setMessagesError(null);
      setMessagesLoading(false);
      return;
    }
    setMessagesLoading(true);
    setMessagesError(null);
    syncDiscussionMessages()
      .catch(() => {
        setMessagesError("메시지를 불러오지 못했습니다.");
      })
      .finally(() => {
        setMessagesLoading(false);
      });
  }, [discussionId, syncDiscussionMessages]);

  useEffect(() => {
    if (!shouldScrollRef.current) return;
    shouldScrollRef.current = false;
    const el = scrollContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [discussionMessages]);

  // reconnect 감지: status=loaded + discussionId 확정 상태에서만 re-sync 허용.
  // 조회 중·not_found·error·생성 중 상태에서는 실행하지 않는다.
  useEffect(() => {
    const wasDisconnected = prevConnectedRef.current === false;
    const isReconnected = connected === true;
    const canSync = status === "loaded" && discussion?.discussionId;

    if (wasDisconnected && isReconnected && canSync) {
      syncDiscussionMessages().catch(() => {
        setMessagesError("메시지를 불러오지 못했습니다.");
      });
    }

    prevConnectedRef.current = connected;
  }, [connected, status, discussion, syncDiscussionMessages]);

  const handleSendMessage = useCallback(() => {
    const trimmed = inputContent.trim();
    if (!trimmed || !discussion || !sendDiscussionMessage) return;
    sendDiscussionMessage(discussion.discussionId, trimmed);
    setInputContent("");
  }, [inputContent, discussion, sendDiscussionMessage]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isComposingRef.current || e.nativeEvent.isComposing) return;
      handleSendMessage();
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    const requestId = ++discussionRequestIdRef.current;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createDiscussion(messageId);
      if (requestId === discussionRequestIdRef.current) {
        setDiscussion(result.data);
        setStatus("loaded");
      }
    } catch (err) {
      if (requestId === discussionRequestIdRef.current) {
        if (err?.response?.status === 409) {
          loadDiscussion();
        } else {
          setCreateError("Discussion 생성에 실패했습니다.");
        }
      }
    } finally {
      // stale 요청의 finally가 이후 요청(다른 messageId)의 creating=true를 조기에 false로 되돌리지 않도록 guard한다.
      if (requestId === discussionRequestIdRef.current) {
        setCreating(false);
      }
    }
  };

  return (
    <div
      className="relative border-l border-orbit-border flex flex-col flex-shrink-0 bg-orbit-sidebar orbit-panel-bg"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 z-10 cursor-col-resize hover:bg-orbit-cyan/20 transition-colors"
        onMouseDown={handleResizeStart}
      />

      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-orbit-border flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current text-orbit-muted flex-shrink-0">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
          </svg>
          <span className="text-sm font-medium text-orbit-secondary">Discussion</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-orbit-muted hover:text-orbit-text hover:bg-orbit-surface2 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
          </svg>
        </button>
      </div>

      {/* Root message preview */}
      <div className="px-4 pt-2.5 pb-3 border-b border-orbit-border flex-shrink-0">
        <p className="text-[11px] text-orbit-subtle/70 mb-2 tracking-wide">Discussing</p>
        <div className="border-l-2 border-orbit-cyan/35 pl-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs font-medium text-orbit-secondary">{message.senderNickname}</span>
            <span className="text-orbit-border/60 text-xs select-none">·</span>
            <span className="text-xs text-orbit-subtle">{formatMessageTime(message.createdDate)}</span>
          </div>
          <div className="max-h-32 overflow-y-auto orbit-scrollbar">
            <MessageContentRenderer content={message.message} className="text-sm text-orbit-text/80" />
          </div>
        </div>
      </div>

      {/* 콘텐츠 */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {status === "loading" && (
          <div className="flex items-center justify-center flex-1">
            <div className="w-5 h-5 border-2 border-orbit-muted border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {status === "not_found" && (
          <div className="flex flex-col items-center justify-center flex-1 gap-4 px-4">
            <svg viewBox="0 0 24 24" className="w-8 h-8 fill-current text-orbit-muted/30">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
            </svg>
            <div className="text-center">
              <p className="text-orbit-muted text-sm font-medium mb-1">Discussion 없음</p>
              <p className="text-orbit-subtle text-xs">
                이 메시지에 대한 Discussion을 시작하세요.
              </p>
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="w-full py-2 bg-orbit-cyan hover:bg-orbit-cyan/80 disabled:bg-orbit-surface2 disabled:text-orbit-muted disabled:cursor-not-allowed rounded-xl text-sm font-medium text-orbit-bg transition-colors"
            >
              {creating ? "생성 중..." : "Start Discussion"}
            </button>
            {createError && (
              <p className="text-xs text-red-400 text-center">{createError}</p>
            )}
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center justify-center flex-1 gap-3 px-4">
            <p className="text-orbit-subtle text-sm text-center">불러오지 못했습니다.</p>
            <button
              onClick={loadDiscussion}
              className="text-xs text-orbit-cyan hover:text-orbit-text transition-colors"
            >
              다시 시도
            </button>
          </div>
        )}

        {status === "loaded" && discussion && (
          <div className="flex-1 flex flex-col overflow-hidden">

            {/* 메시지 목록 */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {messagesLoading && (
                <div className="flex items-center justify-center flex-1">
                  <div className="w-4 h-4 border-2 border-orbit-muted border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {!messagesLoading && messagesError && (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 px-4">
                  <p className="text-sm text-orbit-subtle text-center">{messagesError}</p>
                  <button
                    onClick={() => {
                      setMessagesError(null);
                      setMessagesLoading(true);
                      syncDiscussionMessages()
                        .catch(() => {
                          setMessagesError("메시지를 불러오지 못했습니다.");
                        })
                        .finally(() => {
                          setMessagesLoading(false);
                        });
                    }}
                    className="text-xs text-orbit-cyan hover:text-orbit-text transition-colors"
                  >
                    다시 시도
                  </button>
                </div>
              )}

              {!messagesLoading && !messagesError && discussionMessages.length === 0 && (
                <div className="flex items-center justify-center flex-1 px-4">
                  <p className="text-sm text-orbit-subtle text-center">아직 Discussion 메시지가 없습니다.</p>
                </div>
              )}

              {!messagesLoading && !messagesError && discussionMessages.length > 0 && (
                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto orbit-scrollbar py-3 px-4 flex flex-col gap-2">
                  {discussionMessages.map((dm) => (
                    <DiscussionMessageItem
                      key={dm.discussionMessageId}
                      dm={dm}
                      isMine={dm.senderId === auth?.memberId}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 입력창 */}
            <div className="px-4 py-3 border-t border-orbit-border flex-shrink-0">
              {!connected && (
                <p className="text-xs text-red-400 mb-2 text-center">
                  연결이 끊어져 메시지를 전송할 수 없습니다.
                </p>
              )}
              <div className="flex items-center gap-2 bg-orbit-surface2 rounded-xl border border-orbit-border focus-within:border-orbit-border-strong px-4 py-2.5">
                <textarea
                  rows={1}
                  value={inputContent}
                  onChange={(e) => setInputContent(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={() => { isComposingRef.current = true; }}
                  onCompositionEnd={() => { isComposingRef.current = false; }}
                  placeholder={connected ? "메시지 입력..." : "연결 중..."}
                  disabled={!connected}
                  className="flex-1 min-w-0 bg-transparent text-orbit-text text-sm placeholder:text-orbit-subtle outline-none resize-none max-h-28 leading-5 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!inputContent.trim() || !connected}
                  className="flex-shrink-0 w-8 h-8 rounded-lg bg-orbit-cyan hover:bg-orbit-cyan/80 disabled:bg-orbit-elevated text-orbit-bg disabled:text-orbit-muted disabled:cursor-not-allowed transition-colors flex items-center justify-center"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current -rotate-90">
                    <path d="M2 21L23 12 2 3v7l15 2-15 2v7z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
