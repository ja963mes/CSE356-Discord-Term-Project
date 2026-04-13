import React, { useEffect, useRef, useState } from "react";
import { Me, LinkedIdentity, updateProfile, uploadAvatar, getIdentities, changePassword, unlinkProvider } from "../api/auth";
import { PresenceState } from "../hooks/usePresence";

interface Props {
  me: Me;
  presence: PresenceState;
  onClose: () => void;
  onSend: (msg: object) => boolean;
  onUpdated: (updated: Partial<Me>) => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  oidc: "Course OAuth (CSE 356)",
};

const PROVIDER_ICON: Record<string, React.ReactNode> = {
  google: (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
      <path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
      <path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#fbbc05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  ),
  github: (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  ),
  oidc: (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="#f0ad4e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
    </svg>
  ),
};

const ALL_PROVIDERS = ["google", "github", "oidc"];

export default function ProfileSettingsModal({ me, presence, onClose, onSend, onUpdated }: Props) {
  const [displayName, setDisplayName] = useState(me.profile?.displayName ?? me.username ?? "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(me.profile?.avatar ?? null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isAway, setIsAway] = useState(presence.status === "away");
  const [awayMessage, setAwayMessage] = useState(presence.awayMessage ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Linked accounts state
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null);
  const [linkMessage, setLinkMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // On mount: load identities and check URL params for OAuth link results
  useEffect(() => {
    getIdentities().then(setIdentities).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    const linked = params.get("linked");
    const linkError = params.get("link_error");
    const provider = params.get("provider");

    if (linked) {
      setLinkMessage({ type: "success", text: `${PROVIDER_LABELS[linked] ?? linked} linked successfully.` });
      params.delete("linked");
    } else if (linkError) {
      const msg =
        linkError === "already_linked"
          ? `${PROVIDER_LABELS[provider ?? ""] ?? provider} is already linked to your account.`
          : linkError === "in_use"
          ? `That ${PROVIDER_LABELS[provider ?? ""] ?? provider} account is linked to a different user.`
          : "Failed to link provider.";
      setLinkMessage({ type: "error", text: msg });
      params.delete("link_error");
      if (provider) params.delete("provider");
    }

    if (linked || linkError) {
      const newSearch = params.toString();
      window.history.replaceState({}, "", newSearch ? `?${newSearch}` : window.location.pathname);
      // Refresh identities after a successful link
      if (linked) getIdentities().then(setIdentities).catch(() => {});
    }
  }, []);

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
      const prof = me.profile ?? { displayName: "", avatar: null as string | null };
      let newAvatar = prof.avatar ?? null;

      if (displayName !== (prof.displayName ?? "")) {
        await updateProfile(displayName);
      }
      if (avatarFile) {
        newAvatar = await uploadAvatar(avatarFile);
      }

      onUpdated({ profile: { ...prof, displayName, avatar: newAvatar } });

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

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError("Password must be at least 6 characters");
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword(me.has_password ? currentPassword : undefined, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onUpdated({ has_password: true });
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setPasswordSaving(false);
    }
  }

  async function onUnlink(provider: string) {
    setUnlinkingProvider(provider);
    setLinkMessage(null);
    try {
      await unlinkProvider(provider);
      setIdentities((prev) => prev.filter((i) => i.provider !== provider));
      setLinkMessage({ type: "success", text: `${PROVIDER_LABELS[provider] ?? provider} unlinked.` });
    } catch (err) {
      setLinkMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to unlink" });
    } finally {
      setUnlinkingProvider(null);
    }
  }

  const linkedProviders = new Set(identities.map((i) => i.provider));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-surface-container-low border border-outline-variant/10 rounded-xl shadow-2xl relative flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 pt-7 pb-4 shrink-0">
          <h2 className="font-headline font-extrabold text-2xl tracking-tight text-on-surface">
            Profile Settings
          </h2>
          <button
            className="text-on-surface-variant hover:text-on-surface transition-colors"
            onClick={onClose}
            type="button"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto px-8 pb-8 space-y-8">

          {/* ── Profile section ── */}
          <form className="space-y-5" onSubmit={onSave}>
            {/* Avatar */}
            <div className="flex items-center gap-5">
              <div className="relative flex-shrink-0">
                {avatarPreview ? (
                  <img src={avatarPreview} alt="Avatar" className="w-16 h-16 rounded-full object-cover" />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant font-bold text-xl">
                    {(displayName.trim() || me.username || "?").slice(0, 1).toUpperCase()}
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
              <div className="text-error bg-error-container/20 border border-error-dim/30 rounded-lg px-3 py-2 text-sm">{error}</div>
            )}
            {success && (
              <div className="text-green-400 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2 text-sm">Saved successfully.</div>
            )}

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3.5 bg-gradient-to-br from-primary to-primary-dim text-on-primary font-headline font-bold rounded-lg shadow-lg hover:shadow-primary/20 active:scale-[0.98] transition-all disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </form>

          {/* ── Divider ── */}
          <div className="border-t border-outline-variant/10" />

          {/* ── Security section ── */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-4">
              {me.has_password ? "Change Password" : "Set a Password"}
            </h3>
            <form className="space-y-3" onSubmit={onChangePassword}>
              {me.has_password && (
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">lock</span>
                  </div>
                  <input
                    type="password"
                    className="w-full bg-surface-container-highest border-none rounded-lg py-3 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                  />
                </div>
              )}
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">lock_open</span>
                </div>
                <input
                  type="password"
                  className="w-full bg-surface-container-highest border-none rounded-lg py-3 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">lock_open</span>
                </div>
                <input
                  type="password"
                  className="w-full bg-surface-container-highest border-none rounded-lg py-3 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {passwordError && (
                <div className="text-error bg-error-container/20 border border-error-dim/30 rounded-lg px-3 py-2 text-sm">{passwordError}</div>
              )}
              {passwordSuccess && (
                <div className="text-green-400 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2 text-sm">Password updated.</div>
              )}

              <button
                type="submit"
                disabled={passwordSaving}
                className="w-full py-3 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-semibold rounded-lg hover:bg-surface-bright transition-all disabled:opacity-60"
              >
                {passwordSaving ? "Updating..." : me.has_password ? "Change Password" : "Set Password"}
              </button>
            </form>
          </section>

          {/* ── Divider ── */}
          <div className="border-t border-outline-variant/10" />

          {/* ── Linked Accounts section ── */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-4">
              Linked Accounts
            </h3>

            {linkMessage && (
              <div className={`mb-3 rounded-lg px-3 py-2 text-sm border ${
                linkMessage.type === "success"
                  ? "text-green-400 bg-green-900/20 border-green-700/30"
                  : "text-error bg-error-container/20 border-error-dim/30"
              }`}>
                {linkMessage.text}
              </div>
            )}

            <div className="space-y-2">
              {ALL_PROVIDERS.map((provider) => {
                const isLinked = linkedProviders.has(provider);
                return (
                  <div
                    key={provider}
                    className="flex items-center justify-between bg-surface-container-highest rounded-lg px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {PROVIDER_ICON[provider]}
                      <span className="text-sm font-medium text-on-surface">{PROVIDER_LABELS[provider]}</span>
                      {isLinked && (
                        <span className="text-xs text-green-400 font-semibold">Connected</span>
                      )}
                    </div>
                    {isLinked ? (
                      <button
                        type="button"
                        onClick={() => onUnlink(provider)}
                        disabled={unlinkingProvider === provider}
                        className="text-xs text-error hover:underline underline-offset-2 disabled:opacity-50"
                      >
                        {unlinkingProvider === provider ? "Unlinking..." : "Unlink"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { window.location.href = `/auth/link/${provider}`; }}
                        className="text-xs text-primary hover:underline underline-offset-2"
                      >
                        Link
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
