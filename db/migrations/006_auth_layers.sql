-- Sign-in layers beyond the texted code: passkeys (device biometrics), an authenticator app
-- as a second step, an account PIN for sensitive actions, and optional passwords.
-- Nothing biometric is ever stored here: Face ID, fingerprints and Windows Hello stay on the
-- device, which only hands back a signature from a key it holds.

-- Passwords and usernames are optional at signup. A blank username is generated and can be
-- changed later; a blank password means signing in by passkey or texted code.
alter table accounts alter column password_hash drop not null;
alter table pending_signups alter column password_hash drop not null;

-- The terms the person agreed to by creating the account, and when (consented_at).
alter table accounts add column terms_version text;
update accounts set terms_version = 'pre-2026-11-17' where terms_version is null;
alter table pending_signups add column terms_version text;

alter table accounts
  add column username_changed_at timestamptz,
  add column pin_hash            text,         -- scrypt, like passwords
  add column totp_secret_enc     text,         -- authenticator app secret, encrypted at rest
  add column totp_pending_enc    text,         -- a secret being set up, until its first code checks out
  add column totp_enabled_at     timestamptz,
  add column totp_last_step      bigint;       -- the last 30-second step used, so a code can't be replayed

create table recovery_codes (
  id         bigint generated always as identity primary key,
  account_id integer not null references accounts(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz
);
create index recovery_codes_account on recovery_codes (account_id);

create table passkeys (
  id            text primary key,              -- the credential id, base64url
  account_id    integer not null references accounts(id) on delete cascade,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[],
  device_type   text,                          -- singleDevice or multiDevice (synced)
  backed_up     boolean not null default false,
  name          text not null default 'Passkey',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index passkeys_account on passkeys (account_id);

-- A sign-in or passkey ceremony in progress: the WebAuthn challenge, or a texted code or
-- authenticator step waiting to be entered. Rows last minutes; the phone number for a texted
-- sign-in code is held only until the code is checked, as with signups.
create table auth_challenges (
  token_hash  text primary key,
  kind        text not null check (kind in ('passkey_register', 'passkey_login', 'sms_login', 'mfa')),
  account_id  integer references accounts(id) on delete cascade,
  challenge   text,                            -- WebAuthn challenge
  phone       text,                            -- texted sign-in only
  code_hash   text,                            -- development mode texted code only
  attempts    integer not null default 0,
  next_path   text not null default '/',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index auth_challenges_expiry on auth_challenges (expires_at);
