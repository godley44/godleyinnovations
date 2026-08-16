import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

// Email + 6-digit code sign-in. Chosen over magic links because this is used
// from a tablet: a code can be read from the mail app and typed here without
// the link hijacking the browser tab or opening a second session.
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setBusy(false);
    if (error) setError(error.message);
    else setStage("code");
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (error) setError(error.message);
  }

  if (!ready) return <div className="center-note">Loading…</div>;

  if (!session) {
    return (
      <div className="auth-wrap">
        <h1>Godley Innovations Studio</h1>
        {stage === "email" ? (
          <form onSubmit={sendCode} className="auth-form">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <button disabled={busy}>{busy ? "Sending…" : "Send sign-in code"}</button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="auth-form">
            <p>Enter the 6-digit code sent to {email}.</p>
            <label>
              Code
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </label>
            <button disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
            <button type="button" className="linklike" onClick={() => setStage("email")}>
              Use a different email
            </button>
          </form>
        )}
        {error && <p className="error-banner">{error}</p>}
        <p className="muted">
          Only the owner email configured in the database can read or write
          anything. Other sign-ins see an empty, locked app.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
