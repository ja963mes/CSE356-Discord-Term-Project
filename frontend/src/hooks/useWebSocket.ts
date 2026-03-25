import { useEffect, useRef, useCallback } from "react";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
const RECONNECT_DELAY_MS = 3000;

export type IncomingMessage = {
  type: string;
  [key: string]: unknown;
};

export function useWebSocket(onMessage?: (msg: IncomingMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const shouldReconnect = useRef(true);

  // Keep onMessage ref up to date without re-running the effect
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[ws] connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as IncomingMessage;
        onMessageRef.current?.(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      console.log("[ws] disconnected");
      if (shouldReconnect.current) {
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    shouldReconnect.current = true;
    // Small delay to avoid React 18 Strict Mode double-invoke closing the socket immediately
    const t = setTimeout(connect, 0);

    return () => {
      clearTimeout(t);
      shouldReconnect.current = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { send };
}
