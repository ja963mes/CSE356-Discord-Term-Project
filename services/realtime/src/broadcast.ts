import { WebSocket } from "ws";
import { PresenceStatus } from "./presence";
import { getRelatedUserIds } from "./relationships";

// Broadcasts a presence change to all related users to the current user (friends, guild members, etc.)
export async function broadcastPresenceChange(
  userId: string,
  status: PresenceStatus,
  connections: Map<string, { ws: WebSocket; userId: string }>,
  awayMessage?: string
): Promise<void> {
  // Currently gets all user ids, will get related user ids in the future to only send to relevant users
  const relatedUserIds = await getRelatedUserIds(userId, connections);
  // Always include the user themselves so their own UI updates
  const relatedUserSet = new Set([...relatedUserIds, userId]);

  const payload = JSON.stringify({ type: "presence_update", userId, status, awayMessage });

  // Send the presence update to all related users who are currently connected via the websocket
  for (const { ws, userId: connUserId } of connections.values()) {
    if (relatedUserSet.has(connUserId) && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}
