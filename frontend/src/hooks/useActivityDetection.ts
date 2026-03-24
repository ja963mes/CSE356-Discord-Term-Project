import { useEffect, useRef } from "react";

// 30s base + up to 10s jitter to avoid thundering herd under load
const PING_INTERVAL_MS = 30_000 + Math.random() * 10_000;

export function useActivityDetection(send: (msg: object) => boolean) {
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
        const sent = sendRef.current({ type: "ping" });
        // Only update lastPingRef if the ping was actually sent
        // If WS isn't open yet, keep lastPingRef at 0 so next activity retries
        if (sent) lastPingRef.current = now;
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

    // Attempt initial ping — if WS not open yet it'll be dropped,
    // but we reset lastPingRef so the next activity event fires immediately
    lastPingRef.current = 0;
    maybePing();

    return () => {
      events.forEach((e) => window.removeEventListener(e, maybePing));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
