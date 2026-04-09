import { DmUser } from "../api/auth";
import { Conversation } from "../api/dms";
import { PresenceState } from "../hooks/usePresence";
import UserPresence from "./UserPresence";

interface Props {
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  onNewDm: () => void;
  conversations: Conversation[];
  currentUserId: string | null;
  dmUsers: DmUser[];
  getPresence: (userId: string) => PresenceState;
  unreadByConversationId?: Record<string, boolean>;
}

export default function DmList({
  selectedId,
  onSelect,
  onNewDm,
  conversations,
  currentUserId,
  dmUsers,
  getPresence,
  unreadByConversationId = {},
}: Props) {
  const userMap = new Map(dmUsers.map((u) => [u.internal_id, u]));

  return (
    <>
      <div className="flex items-center justify-between px-2 pt-6 pb-1">
        <span className="text-on-surface-variant uppercase text-[10px] font-bold tracking-widest flex items-center">
          <span className="material-symbols-outlined text-[14px] mr-1">expand_more</span>
          Direct Messages
        </span>
        <button
          type="button"
          title="New DM"
          onClick={onNewDm}
          className="text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
        </button>
      </div>

      {conversations.length === 0 && (
        <p className="px-4 py-2 text-xs text-on-surface-variant">No conversations yet.</p>
      )}

      {conversations.map((c) => {
        const active = c.conversationId === selectedId;

        // For 1-to-1: show the other user. For group: show a generic entry.
        const otherId = c.conversationType === "one_to_one" && currentUserId
          ? ((c.participantIds ?? []).find((id) => id !== currentUserId)
            // Other user may have left — fall back to any participant in dmUsers
            ?? (c.participantIds ?? []).find((id) => userMap.has(id)))
          : undefined;
        const otherUser = otherId ? userMap.get(otherId) : undefined;

        const displayName = otherUser?.profile.displayName
          ?? otherUser?.username
          ?? (c.name ?? (c.conversationType === "one_to_one" ? "Direct Message" : "Group DM"));

        const avatarUrl = otherUser?.profile.avatar ?? undefined;
        const presence = otherId ? getPresence(otherId) : { status: "offline" as const };
        const hasUnread = unreadByConversationId[c.conversationId] ?? c.hasUnread === true;

        return (
          <button
            key={c.conversationId}
            type="button"
            onClick={() => onSelect(c)}
            className={
              active
                ? "flex items-center w-full px-2 py-1.5 rounded-lg bg-surface-container-highest text-on-surface transition-all"
                : "flex items-center w-full px-2 py-1.5 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface transition-all"
            }
          >
            {otherUser ? (
              <UserPresence
                userId={otherId!}
                displayName={displayName}
                avatarUrl={avatarUrl}
                presence={presence}
                size="sm"
              />
            ) : (
              <>
                <span className="material-symbols-outlined text-[18px] flex-shrink-0 mr-2">group</span>
                <span className="text-sm truncate">{displayName}</span>
              </>
            )}
            {hasUnread && !active ? (
              <span className="ml-auto h-2.5 w-2.5 rounded-full bg-[#5865F2] shrink-0" aria-label="Unread messages" />
            ) : null}
          </button>
        );
      })}
    </>
  );
}
