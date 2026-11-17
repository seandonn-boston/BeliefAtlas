"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { totpConfirm } from "@/app/auth-actions";

// The last step of setting up an authenticator app: type its first code, then save the
// recovery codes, which are shown this once.
export function TotpConfirm() {
  const t = useTranslations("auth.totp");
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
        <p>{t("on")}</p>
        <pre className="recovery-codes">{codes.join("\n")}</pre>
        <p><a className="btn" href="/settings/security">{t("done")}</a></p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        {t("code")}
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
      </label>
      {error && <p className="note" role="alert">{error}</p>}
      <button className="btn solid" disabled={busy}>{t("turnOn")}</button>
    </form>
  );
}
