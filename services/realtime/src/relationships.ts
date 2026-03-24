import { WebSocket } from "ws";

// TODO: replace stub with real DB queries once communities and DMs are built.
// Should return all userIds that should be notified when `userId`'s presence changes:
//   - members of any community that `userId` is in
//   - participants of any DM that `userId` is in

export async function getRelatedUserIds(
  userId: string,
  connections: Map<string, { ws: WebSocket; userId: string }>
): Promise<string[]> {
  // Stub: notify all currently connected users except the user whose presence changed
  const related = new Set<string>();
  for (const { userId: connUserId } of connections.values()) {
    if (connUserId !== userId) {
      related.add(connUserId);
    }
  }
  return Array.from(related);
}
