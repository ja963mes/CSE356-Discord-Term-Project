import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Message,
  getMessages,
  postChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  presignAttachments,
  uploadToMinIO,
  markChannelRead,
} from "../api/discord";
import { IncomingMessage } from "../hooks/useWebSocket";
import SearchPanel from "./SearchPanel";

interface Props {
  channelId: string;
  channelName: string;
  isPrivate?: boolean;
  communityId?: string;
  currentUserId: string;
  currentUsername: string;
  wsEvent?: IncomingMessage | null;
  onReadStateUpdated?: (channelId: string, messageId: string, timeuuid: string) => void;
}

const MAX_ATTACHMENTS = 4;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export default function ChannelChatView({
  channelId,
  channelName,
  isPrivate,
  communityId,
  currentUserId,
  currentUsername,
  wsEvent,
  onReadStateUpdated,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [oldestTimeuuid, setOldestTimeuuid] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // Attachment state
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastMarkedRef = useRef<string | null>(null);

  /** Parent often passes a new callback when unread maps change; keep stable deps so we do not re-fetch in a loop. */
  const onReadStateUpdatedRef = useRef(onReadStateUpdated);
  useEffect(() => {
    onReadStateUpdatedRef.current = onReadStateUpdated;
  }, [onReadStateUpdated]);

  const markLatestRead = useCallback(async (message: Message | null | undefined) => {
    if (!message?.id || !message.timeuuid || lastMarkedRef.current === message.id) return;
    const ok = await markChannelRead(channelId, message.id, message.timeuuid);
    if (!ok) return;
    lastMarkedRef.current = message.id;
    onReadStateUpdatedRef.current?.(channelId, message.id, message.timeuuid);
  }, [channelId]);

  // Load initial messages when channel changes (deps: channelId only — avoid refetch storms when parent callbacks change)
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setOldestTimeuuid(null);
    setHasMore(true);
    setComposerText("");
    setPendingFiles([]);
    setEditingId(null);
    lastMarkedRef.current = null;

    getMessages(channelId)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
        if (msgs.length > 0) setOldestTimeuuid(msgs[0].timeuuid);
        if (msgs.length < 50) setHasMore(false);
        const last = msgs[msgs.length - 1] ?? null;
        if (last?.id && last?.timeuuid) {
          void markChannelRead(channelId, last.id, last.timeuuid).then((ok) => {
            if (!ok || cancelled) return;
            lastMarkedRef.current = last.id;
            onReadStateUpdatedRef.current?.(channelId, last.id, last.timeuuid);
          });
        }
        setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // Infinite scroll — load older messages
  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || !oldestTimeuuid) return;
    setLoadingOlder(true);
    try {
      const older = await getMessages(channelId, { before: oldestTimeuuid });
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !existingIds.has(m.id));
        return [...fresh, ...prev];
      });
      setOldestTimeuuid(older[0].timeuuid);
      if (older.length < 50) setHasMore(false);
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, hasMore, loadingOlder, oldestTimeuuid]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 100) loadOlder();
  }, [loadOlder]);

  // Real-time WS events
  useEffect(() => {
    if (!wsEvent) return;
    const e = wsEvent as Record<string, unknown>;
    if (e.channelId !== channelId) return;

    if (e.type === "channel:message:create") {
      const raw = e.message as Record<string, unknown>;
      const msg: Message = {
        id: String(raw.messageId ?? raw.id ?? ""),
        timeuuid: String(raw.timeuuid ?? ""),
        authorId: String(raw.authorId ?? ""),
        author: String(raw.authorUsername ?? raw.author ?? ""),
        content: String(raw.content ?? ""),
        createdAt: String(raw.createdAt ?? ""),
        editedAt: null,
        attachmentKeys: Array.isArray(raw.attachmentKeys) ? (raw.attachmentKeys as string[]) : [],
        attachmentUrls: Array.isArray(raw.attachmentUrls) ? (raw.attachmentUrls as string[]) : [],
      };
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      if (atBottomRef.current) {
        void markLatestRead(msg);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
    } else if (e.type === "channel:message:edit") {
      const raw = e.message as Record<string, unknown>;
      const messageId = String(raw.messageId ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, content: String(raw.content ?? m.content), editedAt: String(raw.editedAt ?? "") }
            : m
        )
      );
    } else if (e.type === "channel:message:delete") {
      const raw = e.message as Record<string, unknown> | undefined;
      const messageId = String(raw?.id ?? raw?.messageId ?? e.id ?? e.messageId ?? "");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, deleted: true, content: "", attachmentKeys: [], attachmentUrls: [] } : m
        )
      );
    }
  }, [wsEvent, channelId, markLatestRead]);

  // Send message
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = composerText.trim();
    if ((!text && pendingFiles.length === 0) || sending) return;
    setSending(true);
    try {
      let attachmentKeys: string[] = [];

      if (pendingFiles.length > 0) {
        setUploadingAttachments(true);
        try {
          const presigned = await presignAttachments(
            pendingFiles.map((f) => ({ filename: f.name, contentType: f.type }))
          );
          await Promise.all(presigned.map((p, i) => uploadToMinIO(p.uploadUrl, pendingFiles[i])));
          attachmentKeys = presigned.map((p) => p.key);
        } finally {
          setUploadingAttachments(false);
        }
      }

      if (!text && attachmentKeys.length === 0) return;

      const msg = await postChannelMessage(channelId, text || "\u200b", attachmentKeys);
      if (msg) {
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        setComposerText("");
        setPendingFiles([]);
        void markLatestRead(msg);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
    } finally {
      setSending(false);
    }
  };

  // Commit edit
  const commitEdit = async (msg: Message) => {
    const text = editText.trim();
    if (!text) return;
    const updated = await editChannelMessage(channelId, msg.timeuuid, text);
    if (updated) {
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, content: text, editedAt: updated.editedAt } : m))
      );
    }
    setEditingId(null);
    setEditText("");
  };

  // Delete message
  const handleDelete = async (msg: Message) => {
    const ok = await deleteChannelMessage(channelId, msg.timeuuid);
    if (ok) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, deleted: true, content: "", attachmentKeys: [], attachmentUrls: [] } : m
        )
      );
    }
  };

  // File picker
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
      .filter((f) => ALLOWED_TYPES.has(f.type))
      .slice(0, MAX_ATTACHMENTS);
    setPendingFiles((prev) => [...prev, ...files].slice(0, MAX_ATTACHMENTS));
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => ALLOWED_TYPES.has(f.type));
    if (files.length > 0) setPendingFiles((prev) => [...prev, ...files].slice(0, MAX_ATTACHMENTS));
  };

  return (
    <section
      className="flex-1 bg-surface-container flex flex-col relative min-w-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Header */}
      <header className="h-16 flex items-center px-6 w-full bg-[#171a1f]/60 backdrop-blur-xl shadow-sm z-10 gap-3">
        <span className="material-symbols-outlined text-on-surface-variant shrink-0">
          {isPrivate ? "lock" : "tag"}
        </span>
        <h1 className="text-[#f6f6fc] font-headline font-bold text-lg tracking-tight truncate">
          {channelName}
        </h1>
        {isPrivate && (
          <span className="text-[10px] font-bold uppercase text-on-surface-variant shrink-0">Private</span>
        )}
        <div className="ml-auto">
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
        </div>
      </header>

      {/* Search overlay */}
      {showSearch && (
        <SearchPanel
          scope="community"
          communityId={communityId}
          onJump={(result) => {
            setShowSearch(false);
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

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4 scroll-smooth"
      >
        {loadingOlder && (
          <p className="text-center text-xs text-on-surface-variant py-2">Loading older messages…</p>
        )}

        {messages.length === 0 && !loadingOlder && (
          <div className="py-10">
            <p className="text-on-surface-variant text-sm">
              Welcome to #{channelName}. Send a message to start the conversation.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          const isOwn = m.authorId === currentUserId;
          const isEditing = editingId === m.id;
          const msgDate = new Date(m.createdAt);
          const prevDate = i > 0 ? new Date(messages[i - 1].createdAt) : null;
          const showDivider = !prevDate || msgDate.toDateString() !== prevDate.toDateString();
          const today = new Date();
          const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
          const dateLabel = msgDate.toDateString() === today.toDateString()
            ? "Today"
            : msgDate.toDateString() === yesterday.toDateString()
            ? "Yesterday"
            : msgDate.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });

          return (
            <React.Fragment key={m.id}>
              {showDivider && (
                <div className="flex items-center gap-3 my-2">
                  <div className="flex-1 h-px bg-outline-variant/30" />
                  <span className="text-[11px] font-semibold text-on-surface-variant shrink-0">{dateLabel}</span>
                  <div className="flex-1 h-px bg-outline-variant/30" />
                </div>
              )}
            <div id={`msg-${m.id}`} className="flex gap-3 items-start group rounded-lg transition-all">
              <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant text-xs flex-shrink-0">
                {(m.author ?? "?").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-on-surface">{m.author}</p>
                  <span className="text-[10px] text-on-surface-variant">
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {isOwn && !isEditing && !m.deleted && (
                    <div className="hidden group-hover:flex items-center gap-1 ml-auto">
                      <button
                        type="button"
                        onClick={() => { setEditingId(m.id); setEditText(m.content); }}
                        className="text-on-surface-variant hover:text-on-surface"
                        title="Edit"
                      >
                        <span className="material-symbols-outlined text-[16px]">edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(m)}
                        className="text-on-surface-variant hover:text-red-400"
                        title="Delete"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  )}
                </div>

                {m.deleted ? (
                  <p className="text-sm italic text-on-surface-variant mt-1">{m.author} has deleted this message</p>
                ) : isEditing ? (
                  <div className="flex gap-2 mt-1 items-center">
                    <input
                      className="flex-1 bg-surface-container-lowest border-none rounded-lg px-3 py-1.5 text-sm text-on-surface focus:ring-1 focus:ring-primary"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void commitEdit(m); }
                        if (e.key === "Escape") { setEditingId(null); setEditText(""); }
                      }}
                      autoFocus
                    />
                    <button type="button" className="text-xs text-primary hover:underline shrink-0" onClick={() => void commitEdit(m)}>Save</button>
                    <button type="button" className="text-xs text-on-surface-variant hover:underline shrink-0" onClick={() => { setEditingId(null); setEditText(""); }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-on-surface mt-1 whitespace-pre-wrap break-words">{m.content}</p>
                    {m.editedAt && (
                      <p className="text-[10px] text-on-surface-variant italic mt-0.5">(edited)</p>
                    )}
                    {m.attachmentUrls.length > 0 && (
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

      {/* Pending file previews */}
      {pendingFiles.length > 0 && (
        <div className="px-4 pt-2 flex gap-2 flex-wrap border-t border-outline-variant/20">
          {pendingFiles.map((f, i) => (
            <div key={i} className="relative">
              <img
                src={URL.createObjectURL(f)}
                alt={f.name}
                className="h-16 w-16 rounded object-cover"
              />
              <button
                type="button"
                onClick={() => setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-white text-[10px] flex items-center justify-center"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <form className="p-4 border-t border-outline-variant/20" onSubmit={handleSend}>
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={pendingFiles.length >= MAX_ATTACHMENTS}
            className="material-symbols-outlined text-on-surface-variant hover:text-on-surface disabled:opacity-30 flex-shrink-0"
            title="Attach image"
          >
            attach_file
          </button>
          <input
            className="flex-1 bg-surface-container-lowest border-none rounded-lg px-4 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary disabled:opacity-50"
            placeholder={`Message #${channelName}`}
            disabled={sending}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
          />
          <button
            type="submit"
            className="material-symbols-outlined text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-40"
            disabled={sending || uploadingAttachments || (!composerText.trim() && pendingFiles.length === 0)}
            aria-label="Send message"
          >
            {uploadingAttachments ? "uploading…" : "send"}
          </button>
        </div>
      </form>
    </section>
  );
}
