import { useEffect, useRef, useCallback, useState } from "react";

const WS_URL = process.env.REACT_APP_WS_URL || "ws://localhost:8080/ws/chat";
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

export function useWebSocket(onMessage) {
  const socketRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const manualCloseRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  // 항상 최신 콜백을 참조하도록 ref 동기화 (렌더마다 실행)
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      reconnectCountRef.current = 0;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current?.(data);
      } catch (e) {
        console.error("WebSocket 메시지 파싱 오류:", e);
      }
    };

    socket.onclose = () => {
      setConnected(false);
      if (manualCloseRef.current) return;
      if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setReconnecting(false);
        return;
      }
      setReconnecting(true);
      reconnectCountRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    socket.onerror = () => {
      console.error("WebSocket 연결 오류");
    };
  }, []);

  useEffect(() => {
    manualCloseRef.current = false;
    connect();

    return () => {
      manualCloseRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  const sendEnterRoom = useCallback((chatRoomId) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "ENTER_ROOM", chatRoomId })
    );
  }, []);

  const sendChatMessage = useCallback((chatRoomId, message, clientMessageId) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "CHAT_MESSAGE", chatRoomId, message, clientMessageId })
    );
  }, []);

  // ROOM_ACTIVE: window focus/visible 복구 시 active 상태를 서버에 알림
  const sendRoomActive = useCallback((chatRoomId) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "ROOM_ACTIVE", chatRoomId })
    );
  }, []);

  // ROOM_INACTIVE: blur/hidden/방 해제 시 inactive 상태를 서버에 알림
  const sendRoomInactive = useCallback((chatRoomId) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "ROOM_INACTIVE", chatRoomId })
    );
  }, []);

  // READ_UP_TO: 현재 room에서 lastReadMessageId까지 읽었음을 서버에 알림 (ChatPage에서 debounce 후 호출)
  const sendReadUpTo = useCallback((chatRoomId, lastReadMessageId) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "READ_UP_TO", chatRoomId, lastReadMessageId })
    );
  }, []);

  const sendDiscussionMessage = useCallback((discussionId, content) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(
      JSON.stringify({ messageType: "DISCUSSION_MESSAGE", discussionId, content })
    );
  }, []);

  return { connected, reconnecting, sendEnterRoom, sendChatMessage, sendRoomActive, sendRoomInactive, sendReadUpTo, sendDiscussionMessage };
}
