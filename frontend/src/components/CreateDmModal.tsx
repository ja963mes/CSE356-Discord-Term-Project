import React, { useEffect, useState } from "react";
import { DmUser, getDmUsers } from "../api/auth";
import { Conversation, ConversationType, createConversation } from "../api/dms";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (conversation: Conversation) => void;
}

export default function CreateDmModal({ open, onClose, onCreated }: Props) {
  const [type, setType] = useState<ConversationType>("one_to_one");
  const [users, setUsers] = useState<DmUser[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setType("one_to_one");
      setSelectedIds(new Set());
      setGroupName("");
      setError(null);
      setSubmitting(false);
      getDmUsers().then(setUsers).catch(() => setUsers([]));
    }
  }, [open]);

  if (!open) return null;

  function toggleUser(userId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        // For 1-to-1, only allow one selection
        if (type === "one_to_one") {
          next.clear();
        }
        next.add(userId);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (selectedIds.size === 0) {
      setError("Select at least one user");
      return;
    }

    if (type === "one_to_one" && selectedIds.size !== 1) {
      setError("Select exactly one user for a direct message");
      return;
    }

    setSubmitting(true);
    try {
      const conversation = await createConversation({
        type,
        participantIds: Array.from(selectedIds),
        name: type === "group" && groupName.trim() ? groupName.trim() : undefined,
      });
      onCreated(conversation);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create conversation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-md rounded-xl bg-[#1e2128] border border-white/10 shadow-2xl p-6 z-[101]">
        <h2 className="text-xl font-bold text-[#f6f6fc] font-headline text-center mb-2">New Message</h2>
        <p className="text-sm text-[#b5bac1] text-center mb-6">
          Start a direct message or group conversation.
        </p>

        <form onSubmit={handleSubmit}>
          {/* Type selector */}
          <div className="flex gap-2 mb-4">
            <button
              type="button"
              onClick={() => { setType("one_to_one"); setSelectedIds(new Set()); }}
              className={
                type === "one_to_one"
                  ? "flex-1 rounded-lg bg-[#5865F2] text-white font-semibold py-2 text-sm transition-colors"
                  : "flex-1 rounded-lg bg-[#2b2d31] text-[#b5bac1] hover:bg-[#35373c] font-semibold py-2 text-sm transition-colors border border-white/5"
              }
            >
              1-to-1
            </button>
            <button
              type="button"
              onClick={() => setType("group")}
              className={
                type === "group"
                  ? "flex-1 rounded-lg bg-[#5865F2] text-white font-semibold py-2 text-sm transition-colors"
                  : "flex-1 rounded-lg bg-[#2b2d31] text-[#b5bac1] hover:bg-[#35373c] font-semibold py-2 text-sm transition-colors border border-white/5"
              }
            >
              Group
            </button>
          </div>

          {/* Group name (only for group) */}
          {type === "group" && (
            <div className="mb-4">
              <label className="block text-xs font-bold uppercase tracking-wider text-[#b5bac1] mb-2">
                Group Name (optional)
              </label>
              <input
                type="text"
                className="w-full rounded-lg bg-[#111318] border border-white/10 text-[#f6f6fc] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#5865F2] placeholder:text-[#6d737a]"
                placeholder="My Group Chat"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={120}
                disabled={submitting}
              />
            </div>
          )}

          {/* User list */}
          <label className="block text-xs font-bold uppercase tracking-wider text-[#b5bac1] mb-2">
            {type === "one_to_one" ? "Select a user" : "Select participants"}
          </label>
          <div className="max-h-48 overflow-y-auto rounded-lg bg-[#111318] border border-white/10 mb-4">
            {users.length === 0 && (
              <p className="px-3 py-4 text-sm text-[#6d737a] text-center">No users found.</p>
            )}
            {users.map((u) => {
              const selected = selectedIds.has(u.internal_id);
              return (
                <button
                  key={u.internal_id}
                  type="button"
                  onClick={() => toggleUser(u.internal_id)}
                  className={
                    selected
                      ? "flex items-center gap-3 w-full px-3 py-2.5 bg-[#5865F2]/20 text-[#f6f6fc] hover:bg-[#5865F2]/30 transition-colors"
                      : "flex items-center gap-3 w-full px-3 py-2.5 text-[#b5bac1] hover:bg-[#2b2d31] transition-colors"
                  }
                >
                  <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs flex-shrink-0">
                    {u.profile.displayName.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="text-sm truncate">{u.profile.displayName}</span>
                  {selected && (
                    <span className="material-symbols-outlined text-[#5865F2] ml-auto text-[18px]">check_circle</span>
                  )}
                </button>
              );
            })}
          </div>

          {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

          <div className="flex justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-[#f6f6fc] hover:bg-[#2b2d31] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || selectedIds.size === 0}
              className="px-6 py-2 rounded-lg text-sm font-semibold bg-[#5865F2] hover:bg-[#4752c4] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
