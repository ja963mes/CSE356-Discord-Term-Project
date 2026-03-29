import React, { useEffect, useRef, useState } from "react";
import type { Community } from "../api/discord";
import { joinCommunity, searchCommunities } from "../api/discord";
import { createCommunity } from "../services/createCommunity";

type MenuProps = {
  open: boolean;
  onClose: () => void;
  onCreate: () => void;
  onJoin: () => void;
};

export function ServerActionMenuModal({ open, onClose, onCreate, onJoin }: MenuProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-md rounded-xl bg-[#1e2128] border border-white/10 shadow-2xl p-6 z-[101]">
        <h2 className="text-xl font-bold text-[#f6f6fc] font-headline text-center mb-2">Add a server</h2>
        <p className="text-sm text-[#b5bac1] text-center mb-6">Create a new community or browse the directory to join one.</p>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={onCreate}
            className="w-full rounded-lg bg-[#5865F2] hover:bg-[#4752c4] text-white font-semibold py-3 px-4 transition-colors"
          >
            Create a server
          </button>
          <button
            type="button"
            onClick={onJoin}
            className="w-full rounded-lg bg-[#2b2d31] hover:bg-[#35373c] text-[#f6f6fc] font-semibold py-3 px-4 transition-colors border border-white/5"
          >
            Join a server
          </button>
        </div>
      </div>
    </div>
  );
}

type CreateProps = {
  open: boolean;
  onBack: () => void;
  onClose: () => void;
  onCreated: (community: Community) => void | Promise<void>;
};

export function CreateCommunityModal({ open, onBack, onClose, onCreated }: CreateProps) {
  const [serverName, setServerName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setServerName("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createCommunity(serverName);
    setSubmitting(false);
    if (result.ok) {
      await Promise.resolve(onCreated(result.community));
      onClose();
      return;
    }
    setError(result.error);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-md rounded-xl bg-[#1e2128] border border-white/10 shadow-2xl p-6 z-[101]">
        <h2 className="text-xl font-bold text-[#f6f6fc] font-headline text-center mb-2">Create your server</h2>
        <p className="text-sm text-[#b5bac1] text-center mb-6">
          Give your new community a personality with a name. You can always change it later.
        </p>

        <form onSubmit={handleCreate}>
          <label className="block text-xs font-bold uppercase tracking-wider text-[#b5bac1] mb-2">Server Name</label>
          <input
            type="text"
            className="w-full rounded-lg bg-[#111318] border border-white/10 text-[#f6f6fc] px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#5865F2] placeholder:text-[#6d737a]"
            placeholder="My cool server"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            maxLength={100}
            autoFocus
            disabled={submitting}
          />
          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}

          <div className="flex justify-between gap-3 mt-8">
            <button
              type="button"
              onClick={onBack}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-[#f6f6fc] hover:bg-[#2b2d31] transition-colors disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={submitting || !serverName.trim()}
              className="px-6 py-2 rounded-lg text-sm font-semibold bg-[#5865F2] hover:bg-[#4752c4] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type JoinPlaceholderProps = {
  open: boolean;
  onBack: () => void;
  onClose: () => void;
  /** IDs of communities the user is already in (sidebar list) — avoids redundant join requests. */
  memberCommunityIds?: ReadonlySet<string>;
  onJoined?: (community: Community) => void | Promise<void>;
};

/** Directory search + join via `POST /communities/:id/join` (communities service). */
export function JoinCommunityPlaceholderModal({
  open,
  onBack,
  onClose,
  memberCommunityIds,
  onJoined,
}: JoinPlaceholderProps) {
  const [query, setQuery] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Community[]>([]);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinErrorById, setJoinErrorById] = useState<Record<string, string>>({});
  /** Blocks re-entrant joins before React state (joiningId) flushes — one click must not fire parallel POSTs. */
  const joinInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHasSearched(false);
    setLoading(false);
    setError(null);
    setResults([]);
    setJoiningId(null);
    setJoinErrorById({});
    joinInFlightRef.current = false;
  }, [open]);

  if (!open) return null;

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setHasSearched(true);
    setLoading(true);
    setError(null);

    try {
      const res = await searchCommunities(q);
      if (res === null) {
        setError("Search service unavailable. Please try again.");
        setResults([]);
        return;
      }
      // Dedupe by id so React keys and join targets stay stable.
      const deduped = Array.from(new Map(res.map((x) => [String(x.id), x])).values());
      setResults(deduped);
    } catch {
      setError("Search failed. Please try again.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleJoinById(communityIdRaw: string) {
    const communityId = String(communityIdRaw ?? "").trim();
    if (!communityId || joinInFlightRef.current) return;
    if (memberCommunityIds?.has(communityId)) return;

    const row = results.find((r) => String(r.id) === communityId);
    if (!row) return;

    joinInFlightRef.current = true;
    setJoinErrorById((prev) => {
      const next = { ...prev };
      delete next[communityId];
      return next;
    });
    setJoiningId(communityId);

    try {
      const result = await joinCommunity(communityId);
      if (result.ok) {
        await Promise.resolve(onJoined?.(row));
        return;
      }
      setJoinErrorById((prev) => ({ ...prev, [communityId]: result.error }));
    } finally {
      joinInFlightRef.current = false;
      setJoiningId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-md rounded-xl bg-[#1e2128] border border-white/10 shadow-2xl p-6 z-[101]">
        <h2 className="text-xl font-bold text-[#f6f6fc] font-headline text-center mb-2">Join a server</h2>
        <p className="text-sm text-[#b5bac1] text-center mb-6">
          Search the public directory for a server. Results load only after you submit a search.
        </p>

        <form onSubmit={handleSearch} className="flex items-center gap-2 mb-4">
          <input
            className="flex-1 bg-[#111318] border border-white/10 text-[#f6f6fc] rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#5865F2] placeholder:text-[#6d737a]"
            placeholder="Search servers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={100}
            autoFocus
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#5865F2] hover:bg-[#4752c4] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </form>

        {error ? <p className="mb-4 text-sm text-red-400">{error}</p> : null}

        {hasSearched ? (
          <div className="max-h-[340px] overflow-y-auto pr-1">
            {loading ? <p className="text-sm text-[#b5bac1]">Searching…</p> : null}

            {!loading && results.length === 0 ? (
              <p className="text-sm text-[#b5bac1]">No servers found.</p>
            ) : null}

            {!loading
              ? results.map((c) => {
                  const id = String(c.id);
                  const already = memberCommunityIds?.has(id) ?? false;
                  const busy = joiningId === id;
                  const joinLocked = joiningId !== null;
                  const rowErr = joinErrorById[id];
                  return (
                    <div key={id} className="px-3 py-2 rounded-lg bg-[#14171d] border border-white/5 mb-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-[#f6f6fc] truncate">{c.name}</p>
                          <p className="text-[10px] text-[#b5bac1] truncate">
                            Created {new Date(c.created_at).toLocaleDateString()}
                          </p>
                          {rowErr ? <p className="text-[10px] text-red-400 mt-0.5 truncate">{rowErr}</p> : null}
                        </div>
                        <button
                          type="button"
                          disabled={already || busy || loading || joinLocked}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleJoinById(id);
                          }}
                          className={
                            already
                              ? "px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#2b2d31] text-[#b5bac1] border border-white/5 cursor-default"
                              : "px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#5865F2] hover:bg-[#4752c4] text-white border border-white/10 disabled:opacity-50"
                          }
                        >
                          {already ? "Member" : busy ? "…" : "Join"}
                        </button>
                      </div>
                    </div>
                  );
                })
              : null}
          </div>
        ) : null}

        <div className="flex justify-end mt-5">
          <button
            type="button"
            onClick={onBack}
            disabled={loading}
            className="px-6 py-2 rounded-lg text-sm font-semibold bg-[#2b2d31] hover:bg-[#35373c] text-[#f6f6fc] disabled:opacity-50 transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
