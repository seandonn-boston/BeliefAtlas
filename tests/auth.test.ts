// Sign-in layers: optional usernames and passwords, texted-code sign-in, the authenticator
// app, recovery codes, the account PIN and passkey ceremonies. Runs against DATABASE_URL and
// removes what it creates.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool, query } from "../lib/db";
import { passwordLogin, startSmsLogin, verifyMfa, verifySmsLogin } from "../lib/login";
import { beginTotp, checkSecondFactor, confirmTotp, disableTotp } from "../lib/mfa";
import { allowedOrigin, finishLogin, finishRegistration, loginOptions, registrationOptions } from "../lib/passkeys";
import { confirmIdentity, pinProblem, setPin } from "../lib/pin";
import { open, seal } from "../lib/secrets";
import { startSignup, verifySignup } from "../lib/signup";
import { base32Decode, base32Encode, codeAt, matchCode, stepAt } from "../lib/totp";
import { randomUsername, renameAccount, usernameProblem } from "../lib/usernames";
import { identityVerifier } from "../lib/identity-verification";

process.env.SMS_DEV_CODE = "135790";
const tag = `a${Date.now().toString(36)}`;
const accountIds: number[] = [];
let n = 0;
const phone = () => `202${String(Date.now() + n++ * 7919).slice(-7)}`;

after(async () => {
  await query("delete from accounts where id = any($1::int[])", [accountIds]);
  await pool.end();
});

async function signUp(extra: { username?: string; password?: string } = {}) {
  const number = phone();
  const started = await startSignup({
    ...extra, phone: number, dob: "1988-08-08", next: "/", ip: `ip-${tag}-${n}`, device: `dev-${tag}-${n}`, challengeToken: "",
  });
  assert.ok(started.ok, started.ok ? "" : started.error);
  if (!started.ok) throw new Error();
  const done = await verifySignup(started.token, "135790");
  assert.ok(done.ok);
  if (!done.ok) throw new Error();
  accountIds.push(done.accountId);
  return { id: done.accountId, phone: number };
}

const username = async (id: number) => (await query<{ username: string }>("select username from accounts where id = $1", [id]))[0].username;

// ---------- Pure helpers ----------

test("TOTP matches the RFC 6238 test vector and refuses replays", () => {
  const secret = Buffer.from("12345678901234567890");
  assert.equal(codeAt(secret, stepAt(59_000), 8), "94287082");
  assert.equal(codeAt(secret, stepAt(1_111_111_109_000), 8), "07081804");
  const b32 = base32Encode(secret);
  assert.equal(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(base32Decode(b32), secret);
  const now = 1_700_000_000_000;
  const code = codeAt(secret, stepAt(now));
  assert.equal(matchCode(b32, code, now, null), stepAt(now));
  assert.equal(matchCode(b32, code, now + 30_000, null), stepAt(now)); // one step of drift is fine
  assert.equal(matchCode(b32, code, now + 90_000, null), null);
  assert.equal(matchCode(b32, code, now, stepAt(now)), null); // already used
  assert.equal(matchCode(b32, "12345", now, null), null);
});

test("sealed secrets open only with the same purpose and untampered", () => {
  process.env.PHONE_PEPPER ??= "test-pepper";
  const sealed = seal("JBSWY3DPEHPK3PXP", "totp-v1");
  assert.equal(open(sealed, "totp-v1"), "JBSWY3DPEHPK3PXP");
  assert.equal(open(sealed, "other"), null);
  assert.equal(open(sealed.slice(0, -2) + "AA", "totp-v1"), null);
});

test("usernames and PINs have simple rules", () => {
  for (let i = 0; i < 50; i++) assert.equal(usernameProblem(randomUsername()), null);
  assert.ok(usernameProblem("ab"));
  assert.ok(usernameProblem("Has Space"));
  assert.ok(usernameProblem("admin_sean"));
  assert.equal(pinProblem("4829"), null);
  for (const weak of ["123", "1111", "1234", "98765", "123456789", "12a4"]) assert.ok(pinProblem(weak), weak);
});

test("passkeys only work from the site's own addresses", () => {
  const env = { NODE_ENV: "production", SITE_URL: "https://beliefatlas.com", VERCEL_URL: "yes-or-no-abc.vercel.app" } as unknown as NodeJS.ProcessEnv;
  assert.equal(allowedOrigin("https://beliefatlas.com", env), "https://beliefatlas.com");
  assert.equal(allowedOrigin("https://yes-or-no-abc.vercel.app", env), "https://yes-or-no-abc.vercel.app");
  assert.equal(allowedOrigin("https://evil.example", env), null);
  assert.equal(allowedOrigin("http://localhost:3000", env), null);
  assert.equal(allowedOrigin("http://localhost:3000", { NODE_ENV: "development" } as NodeJS.ProcessEnv), "http://localhost:3000");
  assert.equal(allowedOrigin("not a url", env), null);
});

test("face and ID checks are switched off", async () => {
  const verifier = identityVerifier();
  assert.equal(verifier.enabled, false);
  assert.equal((await verifier.start(1, "/")).ok, false);
});

// ---------- Accounts ----------

test("signup without a username or password gets a generated, editable name", async () => {
  const { id } = await signUp();
  const name = await username(id);
  assert.equal(usernameProblem(name), null);
  const [row] = await query<{ password_hash: string | null }>("select password_hash from accounts where id = $1", [id]);
  assert.equal(row.password_hash, null);
  // No password means password sign-in can't work for this account.
  const attempt = await passwordLogin(name, "anything at all", `ip-pw-${tag}`, "/");
  assert.equal(attempt.ok, false);

  const renamed = await renameAccount(id, `${tag}_me`);
  assert.ok(renamed.ok);
  assert.equal(await username(id), `${tag}_me`);
  const again = await renameAccount(id, `${tag}_me2`);
  assert.match(!again.ok ? again.error : "", /once a day/);
});

test("signing in with a texted code, and nothing texted to numbers without accounts", async () => {
  const { id, phone: number } = await signUp();
  const started = await startSmsLogin(number, `ip-sms-${tag}`, "/q/1");
  assert.ok(started.ok);
  if (!started.ok) return;
  assert.equal((await verifySmsLogin(started.token, "000000")).ok, false);
  const done = await verifySmsLogin(started.token, "135790");
  assert.ok(done.ok && "accountId" in done);
  assert.equal(done.ok && "accountId" in done ? done.accountId : 0, id);
  assert.equal(done.ok && "next" in done ? done.next : "", "/q/1");
  assert.equal((await verifySmsLogin(started.token, "135790")).ok, false); // used up

  const stranger = await startSmsLogin(phone(), `ip-sms2-${tag}`, "/");
  assert.ok(stranger.ok); // looks the same from outside
  if (!stranger.ok) return;
  assert.equal((await verifySmsLogin(stranger.token, "135790")).ok, false);
});

test("authenticator app: setup, second step at sign-in, recovery codes, turning off", async () => {
  const { id } = await signUp({ username: `${tag}_mfa`, password: "correct horse battery" });
  const { secret } = await beginTotp(id, `${tag}_mfa`);
  const now = Date.now();
  const code = (t: number) => codeAt(base32Decode(secret), stepAt(t));
  assert.equal((await confirmTotp(id, "000000", now)).ok, false);
  const confirmed = await confirmTotp(id, code(now), now);
  assert.ok(confirmed.ok);
  if (!confirmed.ok) return;
  assert.equal(confirmed.recoveryCodes.length, 10);

  // A password is no longer enough on its own.
  const first = await passwordLogin(`${tag}_mfa`, "correct horse battery", `ip-mfa-${tag}`, "/");
  assert.ok(first.ok && "mfaToken" in first);
  if (!first.ok || !("mfaToken" in first)) return;
  assert.equal((await verifyMfa(first.mfaToken, code(now))).ok, false); // the setup code can't be reused
  const later = now + 60_000;
  assert.equal(await checkSecondFactor(id, code(later), later), true);
  assert.equal(await checkSecondFactor(id, code(later), later), false); // nor any code twice

  // A recovery code works once, typed loosely.
  const recovery = confirmed.recoveryCodes[0];
  const viaRecovery = await verifyMfa(first.mfaToken, ` ${recovery.toUpperCase()} `);
  assert.ok(viaRecovery.ok && "accountId" in viaRecovery);
  const second = await passwordLogin(`${tag}_mfa`, "correct horse battery", `ip-mfa-${tag}`, "/");
  if (!second.ok || !("mfaToken" in second)) return assert.fail();
  assert.equal((await verifyMfa(second.mfaToken, recovery)).ok, false);

  await disableTotp(id);
  const third = await passwordLogin(`${tag}_mfa`, "correct horse battery", `ip-mfa-${tag}`, "/");
  assert.ok(third.ok && "accountId" in third);
});

test("account PIN guards sensitive actions", async () => {
  const { id } = await signUp();
  const none = await confirmIdentity(id, {});
  assert.match(!none.ok ? none.error : "", /Set an account PIN/);
  assert.equal((await setPin(id, "1234")).ok, false);
  assert.ok((await setPin(id, "4829")).ok);
  const [row] = await query<{ pin_hash: string }>("select pin_hash from accounts where id = $1", [id]);
  assert.ok(!row.pin_hash.includes("4829"));
  assert.equal((await confirmIdentity(id, { pin: "0000" })).ok, false);
  assert.ok((await confirmIdentity(id, { pin: "4829" })).ok);
  // Changing it needs the current one.
  assert.equal((await setPin(id, "5937", "1111")).ok, false);
  assert.ok((await setPin(id, "5937", "4829")).ok);
});

test("passkey ceremonies are single-use and reject forged responses", async () => {
  const { id } = await signUp({ username: `${tag}_pk` });
  const origin = "http://localhost:3000";
  const reg = await registrationOptions({ id, username: `${tag}_pk` }, origin);
  assert.equal(reg.options.rp.id, "localhost");
  assert.equal(reg.options.authenticatorSelection?.userVerification, "required");
  const forged = {
    id: "AAAA", rawId: "AAAA", type: "public-key" as const, clientExtensionResults: {},
    response: { clientDataJSON: "AAAA", attestationObject: "AAAA", transports: [] },
  };
  assert.equal((await finishRegistration(id, reg.token, forged, origin, "Test")).ok, false);
  // The ceremony was used up by that attempt.
  const replay = await finishRegistration(id, reg.token, forged, origin, "Test");
  assert.match(!replay.ok ? replay.error : "", /too long/);

  const login = await loginOptions(origin, "/");
  assert.equal(login.options.userVerification, "required");
  const unknown = await finishLogin(login.token, {
    id: "nope", rawId: "nope", type: "public-key", clientExtensionResults: {},
    response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA" },
  }, origin);
  assert.equal(unknown.ok, false);
});
