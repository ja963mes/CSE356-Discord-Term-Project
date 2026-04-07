import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Conversation,
  DmMessage,
  listMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  inviteParticipant,
  leaveConversation,
} from "../api/dms";

import { IncomingMessage } from "../hooks/useWebSocket";

interface Props {
  conversation: Conversation;
  currentUserId: string;
  /** internal_id -> display name (from /auth/me + /auth/dm-users) */
  displayNameByUserId: Record<string, string>;
  wsEvent?: IncomingMessage | null;
  onLeave?: (conversationId: string) => void;
}

function authorLabel(authorId: string, displayNameByUserId: Record<string, string>): string {
  return displayNameByUserId[authorId] ?? `${authorId.slice(0, 8)}…`;
}

export default function DmChatView({ conversation, currentUserId, displayNameByUserId, wsEvent, onLeave }: Props) {
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversationId = conversation.conversationId;
  const label = conversation.name ?? (conversation.conversationType === "one_to_one" ? "Direct Message" : "Group DM");

  // Load initial messages when conversation changes
  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    listMessages(conversationId)
      .then((data) => {
        setMessages(data.messages);
        setNextCursor(data.nextCursor);
        // Scroll to bottom after initial load
        setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
      })
      .catch(() => setMessages([]));
  }, [conversationId]);

  // Infinite scroll — load older messages
  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const data = await listMessages(conversationId, { before: nextCursor });
      setMessages((prev) => [...prev, ...data.messages]);
      setNextCursor(data.nextCursor);
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, nextCursor, loadingOlder]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Messages are ordered newest-first from the API, rendered top=newest.
    // But we reverse them for display (oldest on top). So "scroll up" = load older.
    if (el.scrollTop < 100) {
      loadOlder();
    }
  }, [loadOlder]);

  // Send a new message
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = composerText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const msg = await sendMessage(conversationId, text);
      setMessages((prev) =>
        prev.some((m) => m.messageId === msg.messageId) ? prev : [msg, ...prev]
      );
      setComposerText("");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  /** Looks up latest row from state so Save always has a valid `timeuuid` (fixes stale closure / empty key). */
  const commitEdit = async (messageId: string) => {
    const text = editText.trim();
    if (!text) return;
    const msg = messages.find((m) => m.messageId === messageId);
    if (!msg?.timeuuid) return;
    try {
      const updated = await editMessage(conversationId, messageId, text, msg.timeuuid);
      setMessages((prev) => prev.map((m) => (m.messageId === updated.messageId ? updated : m)));
      setEditingId(null);
      setEditText("");
    } catch {
      // ignore
    }
  };

  const handleDelete = async (msg: DmMessage) => {
    if (!msg.timeuuid) return;
    try {
      await deleteMessage(conversationId, msg.messageId, msg.timeuuid);
      setMessages((prev) =>
        prev.map((m) =>
          m.messageId === msg.messageId ? { ...m, deleted: true, content: "", attachmentKeys: [], attachmentUrls: [] } : m
        )
      );
    } catch {
      // ignore
    }
  };

  // Handle realtime WebSocket events for this conversation
  useEffect(() => {
    if (!wsEvent) return;
    const e = wsEvent as Record<string, unknown>;
    if (e.conversationId !== conversationId) return;

    if (e.type === "dm:message:create") {
      const raw = e.message as Record<string, unknown>;
      const msg: DmMessage = {
        messageId: String(raw.messageId),
        conversationId: String(e.conversationId),
        authorId: String(raw.authorId),
        content: String(raw.content ?? ""),
        attachmentKeys: Array.isArray(raw.attachmentKeys) ? (raw.attachmentKeys as string[]) : [],
        attachmentUrls: Array.isArray(raw.attachmentUrls) ? (raw.attachmentUrls as string[]) : [],
        createdAt: String(raw.createdAt ?? ""),
        timeuuid: String(raw.timeuuid ?? ""),
        updatedAt: null,
        deleted: false,
      };
      setMessages((prev) => {
        if (prev.some((m) => m.messageId === msg.messageId)) return prev;
        return [msg, ...prev];
      });
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } else if (e.type === "dm:message:edit") {
      const raw = e.message as Record<string, unknown>;
      const updatedAt = raw.updatedAt != null ? String(raw.updatedAt) : null;
      const timeuuid = raw.timeuuid != null ? String(raw.timeuuid) : undefined;
      setMessages((prev) =>
        prev.map((m) =>
          m.messageId === String(raw.messageId)
            ? {
                ...m,
                content: String(raw.content ?? m.content),
                updatedAt,
                timeuuid: timeuuid ?? m.timeuuid,
                deleted: false,
              }
            : m
        )
      );
    } else if (e.type === "dm:message:delete") {
      const deletedId = String(e.messageId ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.messageId === deletedId ? { ...m, deleted: true, content: "", attachmentKeys: [], attachmentUrls: [] } : m
        )
      );
    }
  }, [wsEvent, conversationId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const uid = inviteUserId.trim();
    if (!uid) return;
    setInviting(true);
    setInviteError(null);
    try {
      await inviteParticipant(conversationId, uid);
      setShowInvite(false);
      setInviteUserId("");
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  };

  const handleLeave = async () => {
    try {
      await leaveConversation(conversationId);
      onLeave?.(conversationId);
    } catch {
      // ignore
    }
  };

  // Messages come from API in newest-first order; reverse for display (oldest on top)
  const displayMessages = [...messages].reverse();

  return (
    <section className="flex-1 bg-surface-container flex flex-col relative min-w-0">
      {/* Header */}
      <header className="h-16 flex items-center justify-between px-6 w-full bg-[#171a1f]/60 backdrop-blur-xl shadow-sm z-10">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-on-surface-variant">
            {conversation.conversationType === "one_to_one" ? "person" : "group"}
          </span>
          <h1 className="text-[#f6f6fc] font-headline font-bold text-lg tracking-tight">
            {label}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {conversation.conversationType === "group" && (
            <button
              type="button"
              onClick={() => setShowInvite((v) => !v)}
              className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface px-2 py-1 rounded hover:bg-surface-container-high transition-colors"
              title="Invite someone"
            >
              <span className="material-symbols-outlined text-[18px]">person_add</span>
              <span className="hidden sm:inline">Invite</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowLeaveConfirm(true)}
            className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-red-400 px-2 py-1 rounded hover:bg-surface-container-high transition-colors"
            title="Leave conversation"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
            <span className="hidden sm:inline">Leave</span>
          </button>
        </div>
      </header>

      {/* Invite panel */}
      {showInvite && (
        <div className="px-6 py-3 bg-surface-container-high border-b border-outline-variant/20">
          <form onSubmit={handleInvite} className="flex items-center gap-2">
            <input
              className="flex-1 bg-surface-container-lowest border-none rounded-lg px-3 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
              placeholder="User ID to invite"
              value={inviteUserId}
              onChange={(e) => setInviteUserId(e.target.value)}
              autoFocus
            />
            <button
              type="submit"
              disabled={inviting || !inviteUserId.trim()}
              className="text-xs bg-primary text-on-primary px-3 py-1.5 rounded-lg disabled:opacity-50"
            >
              {inviting ? "Inviting…" : "Invite"}
            </button>
            <button
              type="button"
              onClick={() => { setShowInvite(false); setInviteUserId(""); setInviteError(null); }}
              className="text-xs text-on-surface-variant hover:text-on-surface"
            >
              Cancel
            </button>
          </form>
          {inviteError && <p className="text-xs text-red-400 mt-1">{inviteError}</p>}
        </div>
      )}

      {/* Leave confirmation */}
      {showLeaveConfirm && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
          <div className="bg-surface-container-highest rounded-xl p-6 shadow-xl w-80">
            <h2 className="text-on-surface font-bold text-base mb-2">Leave conversation?</h2>
            <p className="text-sm text-on-surface-variant mb-5">
              {conversation.conversationType === "one_to_one"
                ? "This will permanently delete the conversation and its history."
                : "You'll no longer receive messages from this group."}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                className="text-sm text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowLeaveConfirm(false); handleLeave(); }}
                className="text-sm bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded-lg"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4 scroll-smooth"
      >
        {loadingOlder && (
          <p className="text-center text-xs text-on-surface-variant py-2">Loading older messages...</p>
        )}

        {displayMessages.length === 0 && !loadingOlder && (
          <div className="py-10 text-on-surface-variant text-sm">
            No messages yet. Start the conversation!
          </div>
        )}

        {displayMessages.map((m) => {
          const isOwn = m.authorId === currentUserId;
          const isEditing = editingId === m.messageId;
          const isDeleted = m.deleted === true;
          const authorName = authorLabel(m.authorId, displayNameByUserId);

          return (
            <div key={m.messageId} className="flex gap-3 items-start group">
              <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs flex-shrink-0">
                {authorName.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-on-surface">{authorName}</p>
                  <span className="text-[10px] text-on-surface-variant">
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {isOwn && !isEditing && !isDeleted && (
                    <div className="hidden group-hover:flex items-center gap-1 ml-auto">
                      <button
                        type="button"
                        onClick={() => { setEditingId(m.messageId); setEditText(m.content); }}
                        className="text-on-surface-variant hover:text-on-surface text-xs"
                        title="Edit"
                      >
                        <span className="material-symbols-outlined text-[16px]">edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={(ev) => { ev.stopPropagation(); void handleDelete(m); }}
                        className="text-on-surface-variant hover:text-red-400 text-xs"
                        title="Delete"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  )}
                </div>

                {isEditing && !isDeleted ? (
                  <div className="flex gap-2 mt-1 items-center">
                    <input
                      className="flex-1 bg-surface-container-lowest border-none rounded-lg px-3 py-1.5 text-sm text-on-surface focus:ring-1 focus:ring-primary"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitEdit(m.messageId);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline shrink-0"
                      onClick={() => void commitEdit(m.messageId)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingId(null); setEditText(""); }}
                      className="text-xs text-on-surface-variant hover:underline shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                ) : isDeleted ? (
                  <p className="text-sm text-on-surface-variant italic mt-1">
                    {authorName} has deleted this message
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-on-surface mt-1 whitespace-pre-wrap break-words">{m.content}</p>
                    {m.updatedAt && (
                      <p className="text-[10px] text-on-surface-variant italic mt-1">edited</p>
                    )}
                    {m.attachmentUrls && m.attachmentUrls.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {m.attachmentUrls.map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                            <img
                              src={url}
                              alt={`attachment ${i + 1}`}
                              className="max-h-48 max-w-xs rounded-lg object-cover cursor-pointer hover:opacity-90"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="p-4 border-t border-outline-variant/20">
        <form onSubmit={handleSend} className="flex items-center gap-3">
          <input
            className="flex-1 bg-surface-container-lowest border-none rounded-lg px-4 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary"
            placeholder={`Message ${label}`}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !composerText.trim()}
            className="material-symbols-outlined text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
          >
            send
          </button>
        </form>
      </div>
    </section>
  );
}
