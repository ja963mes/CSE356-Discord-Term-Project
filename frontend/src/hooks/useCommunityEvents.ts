import { useCallback, useState } from "react";
import { CommunityMember } from "../api/discord";
import { IncomingMessage } from "./useWebSocket";

export function useCommunityEvents() {
  const [members, setMembers] = useState<CommunityMember[]>([]);

  const handleCommunityMessage = useCallback((msg: IncomingMessage, selectedCommunityId: string | null) => {
    if (msg.type === "community:member:join") {
      if ((msg.communityId as string) !== selectedCommunityId) return;
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
      if ((msg.communityId as string) !== selectedCommunityId) return;
      setMembers((prev) => prev.filter((m) => m.user_id !== (msg.userId as string)));
    }
  }, []);

  return { members, setMembers, handleCommunityMessage };
}
