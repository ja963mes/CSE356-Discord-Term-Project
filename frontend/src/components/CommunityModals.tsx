import React, { useEffect, useState } from "react";
import type { Community } from "../api/discord";
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
        <p className="text-sm text-[#b5bac1] text-center mb-6">
          Create a new community or join one with an invite (join flow coming soon).
        </p>
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
};

/** Placeholder until the join service is implemented (see `services/join/`). */
export function JoinCommunityPlaceholderModal({ open, onBack, onClose }: JoinPlaceholderProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-md rounded-xl bg-[#1e2128] border border-white/10 shadow-2xl p-6 z-[101]">
        <h2 className="text-xl font-bold text-[#f6f6fc] font-headline text-center mb-2">Join a server</h2>
        <p className="text-sm text-[#b5bac1] text-center mb-6">
          Joining by invite or directory will be handled by the join service. This screen is a placeholder.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onBack}
            className="px-6 py-2 rounded-lg text-sm font-semibold bg-[#5865F2] hover:bg-[#4752c4] text-white transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
