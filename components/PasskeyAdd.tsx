"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { passkeyRegisterFinish, passkeyRegisterStart } from "@/app/auth-actions";

// Adds a passkey for this device: Face ID, Touch ID, a fingerprint, Windows Hello or a
// security key. The device keeps the private key and the biometric check to itself.
export function PasskeyAdd({ label = "Add a passkey" }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setMessage(null);
    try {
      const start = await passkeyRegisterStart();
      if (!start.ok) return setMessage(start.error);
      const response = await startRegistration({ optionsJSON: start.options });
      const name = navigator.platform ? `Passkey on ${navigator.platform}` : "Passkey";
      const done = await passkeyRegisterFinish(start.token, response, name);
      if (!done.ok) return setMessage(done.error);
      window.location.reload();
    } catch (err) {
      const name = (err as Error).name;
      setMessage(
        name === "InvalidStateError" ? "This device already has a passkey for your account."
          : name === "NotAllowedError" ? "Adding the passkey was cancelled."
          : "This browser couldn't make a passkey.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn solid" onClick={add} disabled={busy}>{busy ? "Waiting for your device…" : label}</button>
      {message && <p className="note" role="alert">{message}</p>}
    </div>
  );
}
