import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login } from "../api/auth";

export default function LoginPage() {
  const navigate = useNavigate();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      // The current auth service only supports username/password locally.
      await login(identifier, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
            The Obsidian Architect
          </h1>
          <p className="text-on-surface-variant font-medium mt-2">Welcome back to the sanctuary.</p>
        </div>

        <div className="glass-panel border border-outline-variant/10 rounded-xl p-8 md:p-10 shadow-2xl">
          <form className="space-y-6" onSubmit={onSubmit}>
            <div className="space-y-5">
              <div className="space-y-2">
                <label
                  className="text-xs font-bold uppercase tracking-widest text-on-surface-variant ml-1"
                  htmlFor="identifier"
                >
                  Email or Username
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
                <div className="flex items-center justify-between ml-1">
                  <label className="text-xs font-bold uppercase tracking-widest text-on-surface-variant" htmlFor="password">
                    Password
                  </label>
                  <a className="text-xs font-semibold text-primary hover:text-primary-fixed-dim transition-colors" href="#">
                    Forgot password?
                  </a>
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
              {isSubmitting ? "Signing in..." : "Log In"}
            </button>

            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-outline-variant/15" />
              <span className="flex-shrink mx-4 text-xs font-bold uppercase tracking-widest text-outline">
                Or continue with
              </span>
              <div className="flex-grow border-t border-outline-variant/15" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                className="flex items-center justify-center gap-3 py-3 px-4 bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-bright transition-all group"
                type="button"
                onClick={() => (window.location.href = "/auth/google")}
              >
                <img
                  alt=""
                  className="w-5 h-5"
                  src="https://lh3.googleusercontent.com/aida-public/AB6AXuDg18PFLhKiqQzm-KkhhcMdWz45b4Pnd7FsbT8QPajIxJ8FEgNSyPPsMkvSaTgV6R6C9qdbWP5ZN3KpnMhfY0sGcSp0fiM64HtN0eSvFYqWRZGz7FMzxl373qKNl1cRRt4Gu0fZ-tZ1M-guubrj3CLKC8nSS_sm2FPXAqJzxFykZ1LivvcaaoMk6JTSB-Ui6wGZZC5Da2Gz929tIr3_WRELeJoZNS9qLFHQ7_fSsdCrLzyrG0M-uxLZzCJf1Q0qmad7jWE5BscEEpA"
                />
                <span className="font-semibold text-sm text-on-surface">Google</span>
              </button>
              <button
                className="flex items-center justify-center gap-3 py-3 px-4 bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-bright transition-all group"
                type="button"
                onClick={() => (window.location.href = "/auth/github")}
              >
                <span className="material-symbols-outlined text-on-surface text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                  ios
                </span>
                <span className="font-semibold text-sm text-on-surface">Apple</span>
              </button>
            </div>

            <p className="text-center text-on-surface-variant text-sm pt-4">
              Need an account?{" "}
              <a className="text-primary font-bold hover:underline underline-offset-4 decoration-2" href="#">
                Register
              </a>
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

