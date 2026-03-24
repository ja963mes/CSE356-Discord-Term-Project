import { useEffect, useRef } from "react";

// 30s base + up to 10s jitter to avoid thundering herd under load
const PING_INTERVAL_MS = 30_000 + Math.random() * 10_000;

export function useActivityDetection(send: (msg: object) => void) {
  const lastPingRef = useRef<number>(0);
  const sendRef = useRef(send);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    function maybePing() {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastPingRef.current >= PING_INTERVAL_MS) {
        lastPingRef.current = now;
        sendRef.current({ type: "ping" });
      }
    }

    function onVisibilityChange() {
      if (!document.hidden) {
        // Tab became visible — ping immediately then resume normal cadence
        lastPingRef.current = 0;
        maybePing();
      }
    }

    const events = ["mousemove", "keydown", "click"] as const;
    events.forEach((e) => window.addEventListener(e, maybePing));
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Send an initial ping on mount
    maybePing();

    return () => {
      events.forEach((e) => window.removeEventListener(e, maybePing));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
