"use server";

import { redirect } from "next/navigation";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getAccount, hashPassword, startSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyMfa, verifySmsLogin, startSmsLogin } from "@/lib/login";
import { beginTotp, confirmTotp, disableTotp } from "@/lib/mfa";
import { allowedOrigin, finishLogin, finishRegistration, loginOptions, registrationOptions, removePasskey } from "@/lib/passkeys";
import { confirmIdentity, setPin } from "@/lib/pin";
import { hit, RULES, tooMany } from "@/lib/rate-limit";
import { clientIp, requestOrigin } from "@/lib/request";
import { renameAccount } from "@/lib/usernames";

// Sign-in steps and the Security settings page. Plain form posts redirect with an error in
// the URL like the rest of the site; the passkey and authenticator calls come from small
// client components and return results instead.

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const safeNext = (next: string) => (next.startsWith("/") && !next.startsWith("//") ? next : "/");
const withError = (path: string, message: string) => `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;
const SECURITY = "/settings/security";

async function signedIn() {
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(SECURITY)}`);
  return account;
}

// ---------- Texted code ----------

export async function smsLoginAction(form: FormData) {
  const next = safeNext(str(form, "back"));
  const result = await startSmsLogin(str(form, "phone"), await clientIp(), next);
  if (!result.ok) redirect(withError(`/login?next=${encodeURIComponent(next)}`, result.error));
  redirect(`/login/code?t=${result.token}`);
}

export async function smsCodeAction(form: FormData) {
  const token = str(form, "token");
  const result = await verifySmsLogin(token, str(form, "code"));
  if (!result.ok) redirect(result.restart ? withError("/login", result.error) : withError(`/login/code?t=${token}`, result.error));
  if ("mfaToken" in result) redirect(`/login/mfa?t=${result.mfaToken}`);
  await startSession(result.accountId);
  redirect(safeNext(result.next));
}

export async function mfaAction(form: FormData) {
  const token = str(form, "token");
  const result = await verifyMfa(token, str(form, "code"));
  if (!result.ok) redirect(result.restart ? withError("/login", result.error) : withError(`/login/mfa?t=${token}`, result.error));
  if ("mfaToken" in result) redirect("/login");
  await startSession(result.accountId);
  redirect(safeNext(result.next));
}

// ---------- Passkeys ----------

async function checkedOrigin(): Promise<string | null> {
  return allowedOrigin(await requestOrigin());
}

export async function passkeyLoginStart(next: string) {
  const limited = await hit([RULES.passkeyPerIp, await clientIp()]);
  if (limited) return { ok: false as const, error: tooMany(limited) };
  const origin = await checkedOrigin();
  if (!origin) return { ok: false as const, error: "Passkeys don't work on this address." };
  return { ok: true as const, ...(await loginOptions(origin, safeNext(next))) };
}

export async function passkeyLoginFinish(token: string, response: AuthenticationResponseJSON) {
  const origin = await checkedOrigin();
  if (!origin) return { ok: false as const, error: "Passkeys don't work on this address." };
  const result = await finishLogin(token, response, origin);
  if (!result.ok) return result;
  await startSession(result.accountId);
  return { ok: true as const, next: safeNext(result.next) };
}

export async function passkeyRegisterStart() {
  const account = await getAccount();
  if (!account) return { ok: false as const, error: "Sign in first." };
  const limited = await hit([RULES.passkeyPerIp, await clientIp()]);
  if (limited) return { ok: false as const, error: tooMany(limited) };
  const origin = await checkedOrigin();
  if (!origin) return { ok: false as const, error: "Passkeys don't work on this address." };
  return { ok: true as const, ...(await registrationOptions(account, origin)) };
}

export async function passkeyRegisterFinish(token: string, response: RegistrationResponseJSON, name: string) {
  const account = await getAccount();
  if (!account) return { ok: false as const, error: "Sign in first." };
  const origin = await checkedOrigin();
  if (!origin) return { ok: false as const, error: "Passkeys don't work on this address." };
  return finishRegistration(account.id, token, response, origin, name);
}

export async function removePasskeyAction(form: FormData) {
  const account = await signedIn();
  const confirmed = await confirmIdentity(account.id, { pin: str(form, "pin"), password: String(form.get("password") ?? "") });
  if (!confirmed.ok) redirect(withError(SECURITY, confirmed.error));
  await removePasskey(account.id, str(form, "id"));
  redirect(SECURITY);
}

// ---------- Username, PIN, password ----------

export async function renameAction(form: FormData) {
  const account = await signedIn();
  const result = await renameAccount(account.id, str(form, "username"));
  redirect(result.ok ? `${SECURITY}?saved=username` : withError(SECURITY, result.error));
}

export async function setPinAction(form: FormData) {
  const account = await signedIn();
  const pin = str(form, "pin");
  if (pin !== str(form, "pin2")) redirect(withError(SECURITY, "The two PINs don't match."));
  const result = await setPin(account.id, pin, str(form, "current"));
  redirect(result.ok ? `${SECURITY}?saved=pin` : withError(SECURITY, result.error));
}

// Adding a first password needs the PIN when one is set; changing a password always needs
// the PIN or the current password.
export async function setPasswordAction(form: FormData) {
  const account = await signedIn();
  const password = String(form.get("new_password") ?? "");
  if (password.length < 8 || password.length > 200) redirect(withError(SECURITY, "Passwords are 8 to 200 characters."));
  const [row] = await query<{ password_hash: string | null; pin_hash: string | null }>(
    "select password_hash, pin_hash from accounts where id = $1",
    [account.id],
  );
  if (row.password_hash || row.pin_hash) {
    const confirmed = await confirmIdentity(account.id, { pin: str(form, "pin"), password: String(form.get("password") ?? "") });
    if (!confirmed.ok) redirect(withError(SECURITY, confirmed.error));
  }
  await query("update accounts set password_hash = $2 where id = $1", [account.id, hashPassword(password)]);
  redirect(`${SECURITY}?saved=password`);
}

// ---------- Authenticator app ----------

export async function totpBeginAction() {
  const account = await signedIn();
  await beginTotp(account.id, account.username);
  redirect(`${SECURITY}?setup=totp`);
}

export async function totpConfirm(code: string) {
  const account = await getAccount();
  if (!account) return { ok: false as const, error: "Sign in first." };
  const limited = await hit([RULES.mfaPerAccount, String(account.id)]);
  if (limited) return { ok: false as const, error: tooMany(limited) };
  return confirmTotp(account.id, code);
}

export async function totpDisableAction(form: FormData) {
  const account = await signedIn();
  const confirmed = await confirmIdentity(account.id, { pin: str(form, "pin"), password: String(form.get("password") ?? "") });
  if (!confirmed.ok) redirect(withError(SECURITY, confirmed.error));
  await disableTotp(account.id);
  redirect(`${SECURITY}?saved=totp-off`);
}
