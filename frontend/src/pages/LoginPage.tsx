import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, register } from "../api/auth";

export default function LoginPage() {
  const navigate = useNavigate();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [identifier, setIdentifier] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function switchMode(m: "login" | "register") {
    setMode(m);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      if (mode === "register") {
        await register(identifier, password, displayName || undefined);
        await login(identifier, password);
      } else {
        await login(identifier, password);
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : mode === "register" ? "Registration failed" : "Login failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-aurora bg-mesh relative overflow-hidden">
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-primary opacity-5 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-tertiary opacity-5 blur-[120px] rounded-full pointer-events-none" />

      <main className="w-full max-w-[480px] z-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-dim mb-4 shadow-[0_0_30px_rgba(87,100,241,0.3)]">
            <span className="material-symbols-outlined text-on-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              terminal
            </span>
          </div>
          <h1 className="font-headline font-extrabold text-3xl tracking-tight text-on-surface">
            {mode === "login" ? "Welcome back" : "Create an account"}
          </h1>
          <p className="text-on-surface-variant font-medium mt-2">
            {mode === "login" ? "Sign in to continue." : "Join the conversation."}
          </p>
        </div>

        <div className="glass-panel border border-outline-variant/10 rounded-xl p-8 md:p-10 shadow-2xl">
          <form className="space-y-6" onSubmit={onSubmit}>
            <div className="space-y-5">
              {mode === "register" && (
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant ml-1" htmlFor="displayName">
                    Display Name
                  </label>
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">badge</span>
                    </div>
                    <input
                      className="w-full bg-surface-container-highest border-none rounded-lg py-3.5 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                      id="displayName"
                      placeholder="Your display name (optional)"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <label
                  className="text-xs font-bold uppercase tracking-widest text-on-surface-variant ml-1"
                  htmlFor="identifier"
                >
                  Username
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">
                      alternate_email
                    </span>
                  </div>
                  <input
                    className="w-full bg-surface-container-highest border-none rounded-lg py-3.5 pl-12 pr-4 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                    id="identifier"
                    name="identifier"
                    placeholder="Enter your handle..."
                    type="text"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoComplete="username"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="ml-1">
                  <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant" htmlFor="password">
                    Password
                  </label>
                </div>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-outline text-lg group-focus-within:text-primary transition-colors">
                      lock
                    </span>
                  </div>
                  <input
                    className="w-full bg-surface-container-highest border-none rounded-lg py-3.5 pl-12 pr-12 text-on-surface placeholder:text-outline focus:ring-2 focus:ring-primary/20 focus:bg-surface-bright transition-all"
                    id="password"
                    name="password"
                    placeholder="••••••••"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-outline hover:text-on-surface transition-colors"
                    type="button"
                    aria-label="Toggle password visibility"
                  >
                    <span className="material-symbols-outlined text-lg">visibility</span>
                  </button>
                </div>
              </div>
            </div>

            {error ? (
              <div className="text-error bg-error-container/20 border border-error-dim/30 rounded-lg px-3 py-2 text-sm">
                {error}
              </div>
            ) : null}

            <button
              className="w-full py-4 bg-gradient-to-br from-primary to-primary-dim text-on-primary font-headline font-bold rounded-lg shadow-lg hover:shadow-primary/20 active:scale-[0.98] transition-all disabled:opacity-60"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? (mode === "register" ? "Creating account..." : "Signing in...") : (mode === "register" ? "Create Account" : "Log In")}
            </button>

            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-outline-variant/15" />
              <span className="flex-shrink mx-4 text-xs font-bold uppercase tracking-widest text-outline">
                Or continue with
              </span>
              <div className="flex-grow border-t border-outline-variant/15" />
            </div>

            <div className="flex flex-col gap-3">
              <button
                className="flex items-center justify-center gap-3 py-3 px-4 bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-bright transition-all group"
                type="button"
                onClick={() => (window.location.href = "/auth/google")}
              >
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24"><path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#fbbc05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                <span className="font-semibold text-sm text-on-surface">Google</span>
              </button>
              <button
                className="flex items-center justify-center gap-3 py-3 px-4 bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-bright transition-all group"
                type="button"
                onClick={() => (window.location.href = "/auth/github")}
              >
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
                <span className="font-semibold text-sm text-on-surface">GitHub</span>
              </button>
              <button
                className="flex items-center justify-center gap-3 py-3 px-4 bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-bright transition-all group"
                type="button"
                onClick={() => (window.location.href = "/auth/oidc")}
              >
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="#f0ad4e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                <span className="font-semibold text-sm text-on-surface">Course OAuth (CSE 356)</span>
              </button>
            </div>

            <p className="text-center text-on-surface-variant text-sm pt-4">
              {mode === "login" ? "Need an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="text-primary font-bold hover:underline underline-offset-4 decoration-2"
                onClick={() => switchMode(mode === "login" ? "register" : "login")}
              >
                {mode === "login" ? "Register" : "Log In"}
              </button>
            </p>

            <footer className="mt-8 flex justify-center gap-6">
              <a className="text-xs font-medium text-outline hover:text-on-surface transition-colors" href="#">
                Privacy Policy
              </a>
              <a className="text-xs font-medium text-outline hover:text-on-surface transition-colors" href="#">
                Terms of Service
              </a>
              <a className="text-xs font-medium text-outline hover:text-on-surface transition-colors" href="#">
                Support
              </a>
            </footer>
          </form>
        </div>
      </main>
    </div>
  );
}

