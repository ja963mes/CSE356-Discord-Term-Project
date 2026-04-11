import { useCallback, useState } from "react";
import { Channel, CommunityMember } from "../api/discord";
import { IncomingMessage } from "./useWebSocket";

export function useCommunityEvents() {
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);

  const handleCommunityMessage = useCallback(
    (msg: IncomingMessage, selectedCommunityId: string | null, currentUserId: string | null) => {
    if ((msg.communityId as string) !== selectedCommunityId) return;

    if (msg.type === "community:member:join") {
      const newMember: CommunityMember = {
        user_id: msg.userId as string,
        username: msg.username as string,
        display_name: msg.displayName as string,
        role: msg.role as string,
        joined_at: msg.joinedAt as string,
      };
      setMembers((prev) => {
        if (prev.some((m) => m.user_id === newMember.user_id)) return prev;
        return [...prev, newMember];
      });
    }

    if (msg.type === "community:member:leave") {
      setMembers((prev) => prev.filter((m) => m.user_id !== (msg.userId as string)));
    }

    if (msg.type === "community:channel:create") {
      const ch = msg.channel as Channel;
      setChannels((prev) => {
        if (prev.some((c) => c.id === ch.id)) return prev;
        const next = [...prev, { ...ch, joined: !ch.is_private }];
        return next.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      });
    }

    if (msg.type === "community:channel:delete") {
      const channelId = msg.channelId as string;
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
    }

    if (msg.type === "community:channel:member:add") {
      if (!currentUserId || (msg.userId as string) !== currentUserId) return;
      const ch = msg.channel as Channel;
      setChannels((prev) => {
        if (prev.some((c) => c.id === ch.id)) return prev;
        const next = [...prev, { ...ch, joined: true }];
        return next.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      });
    }

    if (msg.type === "community:channel:member:remove") {
      if (!currentUserId || (msg.userId as string) !== currentUserId) return;
      const channelId = msg.channelId as string;
      setChannels((prev) => prev.filter((c) => c.id !== channelId));
    }
  },
  []
  );

  return { members, setMembers, channels, setChannels, handleCommunityMessage };
}
