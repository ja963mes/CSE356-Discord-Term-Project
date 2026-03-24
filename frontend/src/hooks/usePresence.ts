import { useState, useCallback } from "react";
import { IncomingMessage } from "./useWebSocket";

export type PresenceStatus = "online" | "idle" | "away" | "offline";

export interface PresenceState {
  status: PresenceStatus;
  awayMessage?: string;
}

export function usePresence() {
  const [presenceMap, setPresenceMap] = useState<Map<string, PresenceState>>(new Map());

  const handleMessage = useCallback((msg: IncomingMessage) => {
    if (msg.type === "presence_update") {
      const userId = msg.userId as string;
      const status = msg.status as PresenceStatus;
      const awayMessage = msg.awayMessage as string | undefined;

      setPresenceMap((prev) => {
        const next = new Map(prev);
        next.set(userId, { status, awayMessage });
        return next;
      });
    }
  }, []);

  const getPresence = useCallback(
    (userId: string): PresenceState => {
      return presenceMap.get(userId) ?? { status: "offline" };
    },
    [presenceMap]
  );

  const setPresence = useCallback((userId: string, state: PresenceState) => {
    setPresenceMap((prev) => {
      const next = new Map(prev);
      next.set(userId, state);
      return next;
    });
  }, []);

  return { handleMessage, getPresence, setPresence, presenceMap };
}
