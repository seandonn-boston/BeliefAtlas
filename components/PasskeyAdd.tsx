"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { startRegistration } from "@simplewebauthn/browser";
import { passkeyRegisterFinish, passkeyRegisterStart } from "@/app/auth-actions";

// Adds a passkey for this device: Face ID, Touch ID, a fingerprint, Windows Hello or a
// security key. The device keeps the private key and the biometric check to itself.
export function PasskeyAdd({ label }: { label?: string }) {
  const t = useTranslations("auth.passkey");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const start = await passkeyRegisterStart();
      if (!start.ok) return setMessage(start.error);
      const response = await startRegistration({ optionsJSON: start.options });
      const name = navigator.platform ? t("nameOn", { platform: navigator.platform }) : t("name");
      const done = await passkeyRegisterFinish(start.token, response, name);
      if (!done.ok) return setMessage(done.error);
      window.location.reload();
    } catch (err) {
      const name = (err as Error).name;
      setMessage(
        name === "InvalidStateError" ? t("already") : name === "NotAllowedError" ? t("addCancelled") : t("cantMake"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn solid" onClick={add} disabled={busy}>{busy ? t("waiting") : label ?? t("add")}</button>
      {message && <p className="note" role="alert">{message}</p>}
    </div>
  );
}
