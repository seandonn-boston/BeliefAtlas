"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { startAuthentication } from "@simplewebauthn/browser";
import { passkeyLoginFinish, passkeyLoginStart } from "@/app/auth-actions";

// "Sign in with a passkey": the phone or computer asks for Face ID, a fingerprint, Windows
// Hello or its PIN, then signs in. Nothing biometric leaves the device.
export function PasskeySignIn({ next }: { next: string }) {
  const t = useTranslations("auth.passkey");
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
      setError(name === "NotAllowedError" ? t("cancelled") : t("unsupported"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <button type="button" className="btn solid" onClick={go} disabled={busy}>
        {busy ? t("waiting") : t("signIn")}
      </button>
      {error && <p className="note" role="alert">{error}</p>}
    </div>
  );
}
