"use client";

import { useState } from "react";
import { totpConfirm } from "@/app/auth-actions";

// The last step of setting up an authenticator app: type its first code, then save the
// recovery codes, which are shown this once.
export function TotpConfirm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await totpConfirm(code);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setCodes(result.recoveryCodes);
  }

  if (codes) {
    return (
      <div>
        <p>The authenticator app is on. Save these recovery codes somewhere safe. Each one works once if you lose your phone, and they won&apos;t be shown again.</p>
        <pre className="recovery-codes">{codes.join("\n")}</pre>
        <p><a className="btn" href="/settings/security">Done</a></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Code from the app
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      </label>
      {error && <p className="note" role="alert">{error}</p>}
      <button className="btn solid" disabled={busy}>Turn on</button>
    </form>
  );
}
