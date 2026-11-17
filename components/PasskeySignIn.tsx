"use client";

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { passkeyLoginFinish, passkeyLoginStart } from "@/app/auth-actions";

// "Sign in with a passkey": the phone or computer asks for Face ID, a fingerprint, Windows
// Hello or its PIN, then signs in. Nothing biometric leaves the device.
export function PasskeySignIn({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const start = await passkeyLoginStart(next);
      if (!start.ok) return setError(start.error);
      const response = await startAuthentication({ optionsJSON: start.options });
      const done = await passkeyLoginFinish(start.token, response);
      if (!done.ok) return setError(done.error);
      window.location.assign(done.next);
    } catch (err) {
      const name = (err as Error).name;
      setError(name === "NotAllowedError" ? "Passkey sign-in was cancelled." : "This browser couldn't use a passkey here.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <button type="button" className="btn solid" onClick={go} disabled={busy}>
        {busy ? "Waiting for your device…" : "Sign in with a passkey"}
      </button>
      {error && <p className="note" role="alert">{error}</p>}
    </div>
  );
}
