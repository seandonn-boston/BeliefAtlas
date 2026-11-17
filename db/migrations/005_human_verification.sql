-- Age and human checks at signup.
--
-- The date of birth is checked when someone signs up and then thrown away. The account keeps
-- only the fact that an adult check passed, when, and how. If a later feature needs age bands
-- for the data API, that is a separate decision with its own consent.

alter table accounts
  add column age_verified_at timestamptz,
  add column age_method      text check (age_method in (
    'checkbox',             -- accounts made before this migration ticked "I am 18 or older"
    'dob',                  -- typed (or autofilled) a date of birth on the web
    'digital_credential',   -- reserved: an over-18 claim from a wallet ID (Digital Credentials API)
    'declared_age_range',   -- reserved: Apple's Declared Age Range, from the iOS app
    'play_age_signals'      -- reserved: Google Play Age Signals, from the Android app
  )),
  add column phone_line_type text;  -- what the line-type lookup said at signup (mobile, unknown, ...)

update accounts set age_verified_at = consented_at, age_method = 'checkbox' where age_method is null;

alter table pending_signups
  add column age_method      text not null default 'dob',
  add column age_verified_at timestamptz not null default now(),
  add column phone_line_type text;
