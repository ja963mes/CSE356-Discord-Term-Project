import React, { useRef, useState } from "react";
import { Me, updateProfile, uploadAvatar } from "../api/auth";
import { PresenceState } from "../hooks/usePresence";

interface Props {
  me: Me;
  presence: PresenceState;
  onClose: () => void;
  onSend: (msg: object) => boolean;
  onUpdated: (updated: Partial<Me>) => void;
}

export default function ProfileSettingsModal({ me, presence, onClose, onSend, onUpdated }: Props) {
  const [displayName, setDisplayName] = useState(me.profile.displayName);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(me.profile.avatar);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isAway, setIsAway] = useState(presence.status === "away");
  const [awayMessage, setAwayMessage] = useState(presence.awayMessage ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      let newAvatar = me.profile.avatar;

      if (displayName !== me.profile.displayName) {
        await updateProfile(displayName);
      }
      if (avatarFile) {
        newAvatar = await uploadAvatar(avatarFile);
      }

      onUpdated({ profile: { ...me.profile, displayName, avatar: newAvatar } });

      if (isAway) {
        onSend({ type: "away", message: awayMessage });
      } else {
        onSend({ type: "back" });
        onSend({ type: "ping" });
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-surface-container-low border border-outline-variant/10 rounded-xl p-8 shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          className="absolute top-4 right-4 text-on-surface-variant hover:text-on-surface transition-colors"
          onClick={onClose}
          type="button"
        >
          <span className="material-symbols-outlined">close</span>
        </button>

        <h2 className="font-headline font-extrabold text-2xl tracking-tight text-on-surface mb-6">
          Profile Settings
        </h2>

        <form className="space-y-5" onSubmit={onSave}>
          {/* Avatar */}
          <div className="flex items-center gap-5">
            <div className="relative flex-shrink-0">
              {avatarPreview ? (
                <img src={avatarPreview} alt="Avatar" className="w-16 h-16 rounded-full object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant font-bold text-xl">
                  {displayName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
              >
                <span className="material-symbols-outlined text-white text-lg">photo_camera</span>
              </button>
            </div>
            <div>
              <p className="text-sm font-semibold text-on-surface">Avatar</p>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="text-xs text-primary hover:underline underline-offset-2 mt-0.5"
              >
                Upload image
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
            </div>
          </div>

          {/* Display name */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant ml-1" htmlFor="displayName">
              Display Name
            </label>
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">badge</span>
              </div>
              <input
                id="displayName"
                className="w-full bg-surface-container-highest border-none rounded-lg py-3.5 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Away toggle */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                Set as Away
              </label>
              <button
                type="button"
                onClick={() => setIsAway((v) => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${isAway ? "bg-primary" : "bg-surface-container-highest"}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${isAway ? "translate-x-5" : "translate-x-0"}`} />
              </button>
            </div>
            {isAway && (
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">chat_bubble</span>
                </div>
                <input
                  className="w-full bg-surface-container-highest border-none rounded-lg py-3.5 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                  placeholder="Away message (optional)"
                  value={awayMessage}
                  onChange={(e) => setAwayMessage(e.target.value)}
                />
              </div>
            )}
          </div>

          {error && (
            <div className="text-error bg-error-container/20 border border-error-dim/30 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="text-green-400 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2 text-sm">
              Saved successfully.
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3.5 bg-gradient-to-br from-primary to-primary-dim text-on-primary font-headline font-bold rounded-lg shadow-lg hover:shadow-primary/20 active:scale-[0.98] transition-all disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </form>
      </div>
    </div>
  );
}
