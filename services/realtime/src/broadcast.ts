import { WebSocket } from "ws";
import { PresenceStatus } from "./presence";
import { getRelatedUserIds } from "./relationships";

export async function broadcastPresenceChange(
  userId: string,
  status: PresenceStatus,
  connections: Map<string, { ws: WebSocket; userId: string }>
): Promise<void> {
  const relatedUserIds = await getRelatedUserIds(userId, connections);
  const relatedUserSet = new Set(relatedUserIds);

  const payload = JSON.stringify({ type: "presence_update", userId, status });

  for (const { ws, userId: connUserId } of connections.values()) {
    if (relatedUserSet.has(connUserId) && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}
