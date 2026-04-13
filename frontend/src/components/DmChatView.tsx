import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationReadState,
  DmMessage,
  getConversationReadState,
  listMessages,
  markConversationRead,
  sendMessage,
  editMessage,
  deleteMessage,
  inviteParticipant,
  leaveConversation,
} from "../api/dms";
import { DmUser, displayNameForDmUser, getDmUsers } from "../api/auth";
import SearchPanel from "./SearchPanel";

import { IncomingMessage } from "../hooks/useWebSocket";

interface Props {
  conversation: Conversation;
  currentUserId: string;
  /** internal_id -> display name (from /auth/me + /auth/dm-users) */
  displayNameByUserId: Record<string, string>;
  wsEvent?: IncomingMessage | null;
  onLeave?: (conversationId: string) => void;
  onReadStateUpdated?: (conversationId: string, messageId: string, timeuuid: string) => void;
}

function authorLabel(authorId: string | undefined | null, displayNameByUserId: Record<string, string>): string {
  if (authorId == null || authorId === "") return "Unknown";
  const fromMap = displayNameByUserId[authorId];
  if (typeof fromMap === "string" && fromMap.trim() !== "") return fromMap;
  return `${authorId.slice(0, 8)}…`;
}

export default function DmChatView({
  conversation,
  currentUserId,
  displayNameByUserId,
  wsEvent,
  onLeave,
  onReadStateUpdated,
}: Props) {
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [inviteSearch, setInviteSearch] = useState("");
  const [inviteUsers, setInviteUsers] = useState<DmUser[]>([]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [readStateByUserId, setReadStateByUserId] = useState<Record<string, string | null>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastMarkedRef = useRef<string | null>(null);

  const conversationId = conversation.conversationId;
  const label = conversation.name ?? (conversation.conversationType === "one_to_one" ? "Direct Message" : "Group DM");
  const participantSet = new Set(conversation.participantIds);

  const isTimeuuidAfter = useCallback((a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!a) return false;
    if (!b) return true;
    const parse = (value: string): bigint => {
      const parts = value.toLowerCase().split("-");
      if (parts.length !== 5) return 0n;
      const timeLow = BigInt(`0x${parts[0]}`);
      const timeMid = BigInt(`0x${parts[1]}`);
      const timeHi = BigInt(`0x${parts[2]}`) & 0x0fffn;
      return (timeHi << 48n) | (timeMid << 32n) | timeLow;
    };
    return parse(a) > parse(b);
  }, []);

  const markLatestRead = useCallback(async (message: DmMessage | null | undefined) => {
    if (!message?.timeuuid || lastMarkedRef.current === message.timeuuid) return;
    try {
      await markConversationRead(conversationId, message.timeuuid);
      lastMarkedRef.current = message.timeuuid;
      setReadStateByUserId((prev) => ({ ...prev, [currentUserId]: message.timeuuid }));
      onReadStateUpdated?.(conversationId, message.messageId, message.timeuuid);
    } catch {
      // ignore
    }
  }, [conversationId, currentUserId, onReadStateUpdated]);

  // Load available users when invite panel opens
  useEffect(() => {
    if (showInvite) {
      setInviteSearch("");
      setInviteError(null);
      getDmUsers().then(setInviteUsers).catch(() => setInviteUsers([]));
    }
  }, [showInvite]);

  // Load initial messages when conversation changes
  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    setReadStateByUserId({});
    lastMarkedRef.current = null;
    Promise.all([listMessages(conversationId), getConversationReadState(conversationId)])
      .then(([data, readState]) => {
        setMessages(data.messages);
        setNextCursor(data.nextCursor);
        setReadStateByUserId(Object.fromEntries(readState.map((row) => [row.userId, row.lastReadTimeuuid])));
        void markLatestRead(data.messages[0] ?? null);
        // Scroll to bottom after initial load
        setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
      })
      .catch(() => {
        setMessages([]);
        setReadStateByUserId({});
      });
  }, [conversationId, markLatestRead]);

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
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
      void markLatestRead(msg);
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
      const updated = await editMessage(conversationId, text, msg.timeuuid);
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
      await deleteMessage(conversationId, msg.timeuuid);
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
      if (atBottomRef.current || raw.authorId === currentUserId) {
        void markLatestRead(msg);
      }
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
      const raw = e.message as Record<string, unknown> | undefined;
      const deletedId = String(raw?.messageId ?? e.messageId ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.messageId === deletedId ? { ...m, deleted: true, content: "", attachmentKeys: [], attachmentUrls: [] } : m
        )
      );
    } else if (e.type === "dm:read-state:update") {
      const userId = String(e.userId ?? "");
      const timeuuid = String(e.timeuuid ?? "");
      if (userId && timeuuid) {
        setReadStateByUserId((prev) => ({ ...prev, [userId]: timeuuid }));
      }
    }
  }, [wsEvent, conversationId, currentUserId, markLatestRead]);

  const handleInvite = async (userId: string) => {
    setInviting(true);
    setInviteError(null);
    try {
      await inviteParticipant(conversationId, userId);
      setShowInvite(false);
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
  const latestMessageId = messages[0]?.messageId ?? null;

  function getReadersForMessage(message: DmMessage): ConversationReadState[] {
    return conversation.participantIds
      .filter((userId) => userId !== message.authorId)
      .map((userId) => ({
        userId,
        lastReadMessageId: null,
        lastReadTimeuuid: readStateByUserId[userId] ?? null,
      }))
      .filter((row) =>
        row.lastReadTimeuuid != null &&
        (row.lastReadTimeuuid === message.timeuuid || isTimeuuidAfter(row.lastReadTimeuuid, message.timeuuid))
      );
  }

  return (
    <section className="flex-1 flex min-w-0">
      <div className="flex-1 bg-surface-container flex flex-col relative min-w-0">
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
          <button
            type="button"
            onClick={() => setShowSearch((v) => !v)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
              showSearch
                ? "text-primary bg-primary/10"
                : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
            }`}
            title="Search messages"
          >
            <span className="material-symbols-outlined text-[18px]">search</span>
            <span className="hidden sm:inline">Search</span>
          </button>
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

      {/* Search overlay */}
      {showSearch && (
        <SearchPanel
          scope="dm"
          conversationId={conversationId}
          displayNames={displayNameByUserId}
          onJump={(result) => {
            setShowSearch(false);
            // Scroll to message if it's already loaded
            const el = document.getElementById(`msg-${result.message_id}`);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              el.classList.add("ring-1", "ring-primary/50");
              setTimeout(() => el.classList.remove("ring-1", "ring-primary/50"), 2000);
            }
          }}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Invite panel */}
      {showInvite && (
        <div className="px-6 py-3 bg-surface-container-high border-b border-outline-variant/20">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
              Invite a member
            </label>
            <button
              type="button"
              onClick={() => { setShowInvite(false); setInviteError(null); }}
              className="text-xs text-on-surface-variant hover:text-on-surface"
            >
              Cancel
            </button>
          </div>
          <input
            type="text"
            className="w-full bg-surface-container-lowest border-none rounded-lg px-3 py-1.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary mb-2"
            placeholder="Search by username or display name..."
            value={inviteSearch}
            onChange={(e) => setInviteSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto rounded-lg bg-surface-container-lowest border border-outline-variant/20">
            {inviteUsers
              .filter((u) => !participantSet.has(u.internal_id))
              .filter((u) => {
                if (!inviteSearch.trim()) return true;
                const q = inviteSearch.toLowerCase();
                const label = displayNameForDmUser(u);
                return (
                  u.username.toLowerCase().includes(q) || label.toLowerCase().includes(q)
                );
              })
              .map((u) => {
                const inviteLabel = displayNameForDmUser(u);
                return (
                <button
                  key={u.internal_id}
                  type="button"
                  disabled={inviting}
                  onClick={() => void handleInvite(u.internal_id)}
                  className="flex items-center gap-3 w-full px-3 py-2 text-on-surface hover:bg-surface-variant/50 transition-colors disabled:opacity-50"
                >
                  <div className="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs flex-shrink-0">
                    {inviteLabel.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex flex-col items-start min-w-0">
                    <span className="text-sm truncate">{inviteLabel}</span>
                    <span className="text-[10px] text-on-surface-variant truncate">{u.username}</span>
                  </div>
                  <span className="material-symbols-outlined text-[18px] text-on-surface-variant ml-auto">person_add</span>
                </button>
                );
              })}
            {inviteUsers.filter((u) => !participantSet.has(u.internal_id)).length === 0 && (
              <p className="px-3 py-3 text-sm text-on-surface-variant text-center">No users available to invite.</p>
            )}
          </div>
          {inviteError && <p className="text-xs text-red-400 mt-2">{inviteError}</p>}
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

        {displayMessages.map((m, i) => {
          const isOwn = m.authorId === currentUserId;
          const isEditing = editingId === m.messageId;
          const isDeleted = m.deleted === true;
          const readers = isOwn && !isDeleted && m.messageId === latestMessageId ? getReadersForMessage(m) : [];
          const authorName = authorLabel(m.authorId, displayNameByUserId);
          const msgDate = new Date(m.createdAt);
          const prevDate = i > 0 ? new Date(displayMessages[i - 1].createdAt) : null;
          const showDivider = !prevDate || msgDate.toDateString() !== prevDate.toDateString();
          const today = new Date();
          const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
          const dateLabel = msgDate.toDateString() === today.toDateString()
            ? "Today"
            : msgDate.toDateString() === yesterday.toDateString()
            ? "Yesterday"
            : msgDate.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });

          return (
            <React.Fragment key={m.messageId}>
              {showDivider && (
                <div className="flex items-center gap-3 my-2">
                  <div className="flex-1 h-px bg-outline-variant/30" />
                  <span className="text-[11px] font-semibold text-on-surface-variant shrink-0">{dateLabel}</span>
                  <div className="flex-1 h-px bg-outline-variant/30" />
                </div>
              )}
            <div id={`msg-${m.messageId}`} className="flex gap-3 items-start group rounded-lg transition-all">
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
                    {readers.length > 0 && (
                      <p className="text-[10px] text-on-surface-variant mt-1">
                        Read by {readers.map((row) => authorLabel(row.userId, displayNameByUserId)).join(", ")}
                      </p>
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
            </React.Fragment>
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
      </div>

      {/* Participant sidebar for group DMs */}
      {conversation.conversationType === "group" && (
        <aside className="w-56 bg-surface-container-low border-l border-outline-variant/20 flex flex-col flex-shrink-0">
          <div className="h-16 flex items-center px-4 text-on-surface-variant uppercase text-[10px] font-bold tracking-widest">
            Members — {conversation.participantIds.length}
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4 flex flex-col gap-1">
            {conversation.participantIds.map((pid) => {
              const name = authorLabel(pid, displayNameByUserId);
              const isMe = pid === currentUserId;
              return (
                <div key={pid} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-variant/40">
                  <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs flex-shrink-0">
                    {name.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm text-on-surface truncate">
                    {name}{isMe ? " (you)" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      )}
    </section>
  );
}
