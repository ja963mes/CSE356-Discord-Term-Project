import React, { useEffect, useState } from "react";
import { Conversation, listConversations } from "../api/dms";

interface Props {
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  onNewDm: () => void;
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
}

export default function DmList({ selectedId, onSelect, onNewDm, conversations, setConversations }: Props) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  }, [setConversations]);

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

      {loading && (
        <p className="px-4 py-2 text-xs text-on-surface-variant">Loading...</p>
      )}

      {!loading && conversations.length === 0 && (
        <p className="px-4 py-2 text-xs text-on-surface-variant">No conversations yet.</p>
      )}

      {conversations.map((c) => {
        const active = c.conversationId === selectedId;
        const label = c.name ?? (c.conversationType === "one_to_one" ? "Direct Message" : "Group DM");
        const icon = c.conversationType === "one_to_one" ? "person" : "group";

        return (
          <button
            key={c.conversationId}
            type="button"
            onClick={() => onSelect(c)}
            className={
              active
                ? "flex items-center gap-2 w-full px-2 py-1.5 rounded-lg bg-surface-container-highest text-on-surface font-semibold transition-all"
                : "flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface transition-all"
            }
          >
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
            <span className="text-sm truncate">{label}</span>
          </button>
        );
      })}
    </>
  );
}
