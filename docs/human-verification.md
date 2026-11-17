# Human and age verification

Belief Map only works if every account is one adult human. This doc sets out the layers that
get us there on the web now and in native iOS and Android apps later, what each layer stops,
what it costs, and what we keep.

Status labels: **Built** is in this branch. **Planned** is decided and waits on something
named. **Option** is worth weighing later.

## What Sean saw, and what we can copy

Signing up to an app with Sign in with Apple, the birthday seemed to come from the phone.
Sign in with Apple itself never shares a birthday; it gives a name and an email. What does
exist is one of two things:

- **Declared Age Range (Apple, iOS 26+).** With the person's consent, a native app asks iOS
  whether the person is above or below age thresholds the app picks (for us, 18) and gets back
  a range, not a date. The answer comes from the age on the Apple Account.
- **Browser autofill of a birthday field.** A web form whose date field is marked
  `autocomplete="bday"` can be filled by Safari or Chrome from the person's own contact card.

We use the second on the web now and plan the first for the iOS app, with Google's equivalent
on Android. Neither is proof of age on its own; both make the honest path one tap.

## The layers

| Layer | Where | Stops | Cost | Status |
|---|---|---|---|---|
| Date of birth with an 18+ gate | Web | Minors who answer honestly, and casual retries | Free | **Built** |
| Phone code by SMS (Twilio Verify) | All | One person making many accounts; scripts without a real phone | About $0.05 per signup plus SMS fees | Built earlier, kept |
| Phone line-type lookup (Twilio Lookup) | All | Bot farms using rented VoIP and virtual numbers | About $0.008 per lookup | **Built**, off until switched on |
| Invisible challenge (Cloudflare Turnstile) | Web | Headless browsers and scripts hitting the signup form | Free | **Built** |
| Rate limits | All | Bulk signups and scripted voting | Free | **Built** (added to the existing ones) |
| Declared Age Range | iOS app | Minors, using the age Apple already holds | Free | **Planned** for the iOS app |
| Play Age Signals | Android app | Minors, using the age Google already holds | Free | **Planned** for the Android app |
| App Attest / Play Integrity | Native apps | Requests from emulators, modified apps and scripts | Free (Play Integrity has a daily quota) | **Planned** with the native apps |
| Passkeys with device biometrics | Web now, native later | Password stuffing, phishing, shared logins | Free | **Built** |
| Authenticator app (TOTP) as a second step | All | Someone with a stolen password or SIM-swapped number | Free | **Built** |
| Account PIN for sensitive actions | All | Someone using a signed-in device that isn't theirs | Free | **Built** |
| Digital Credentials API | Web | Minors, with a wallet ID's over-18 claim | Free to call; a verifier library or vendor to read the result | Option |
| Face scan with ID document | All | Most of what's left, including one person with several SIMs | About $1 to $3 per check (Persona, Veriff, Yoti and similar) | Interface **built, switched off** (paid) |

No single layer is enough. An age check does almost nothing against bots, which can type any
date. The phone code, the line-type lookup and the challenge do the bot work; the age layers
keep minors out.

## Built in this branch

### Date of birth, 18+ gate

- The signup form asks for a date of birth (`<input type="date" autocomplete="bday">`). It
  replaces the old "I am 18 or older" tick box.
- The question is neutral: the form doesn't say what age passes, so it doesn't coach a
  younger person on what to enter.
- Age is worked out against the earliest calendar date anywhere on Earth (UTC-12), so nobody
  counts as 18 before their birthday has started where they live. A 29 February birthday
  arrives on 1 March in other years.
- A date under 18 sets a cookie that keeps that browser off the form for 24 hours, so the gate
  can't be passed by stepping the year back until it works.
- Dates in the future or more than 120 years back are rejected as typos, without the lockout.

**What we store: no date of birth.** The date is checked when the form is submitted and
thrown away. The account keeps `age_verified_at` (when) and `age_method` (how). Existing
accounts are marked `checkbox`. New web accounts are `dob`. The methods
`declared_age_range`, `play_age_signals` and `digital_credential` are already allowed by the
schema, so a native app result slots in as another method with no migration. If the data API
ever needs age bands, that needs its own consent and its own column; it isn't a reason to keep
birthdays now.

### Phone verification, hardened

- The texted code (Twilio Verify) is unchanged: no account exists until the code checks out,
  and only a hash of the number is kept. Twilio is paid, so it also needs `TWILIO_ENABLED=true`
  (see "Money" below).
- Before the code is sent, a pluggable line-type check runs (`lib/phone-check.ts`). The
  interface has two implementations: a no-op used by default and in development, and a
  Twilio Lookup v2 adapter switched on with `PHONE_LINE_CHECK=twilio`.
- Policy: mobile and personal numbers pass; fixed and non-fixed VoIP, landlines, toll-free,
  premium, pager and voicemail numbers are turned away with a plain message. Numbers the
  lookup can't classify pass by default, because many genuine non-US mobiles come back
  unknown; `PHONE_ALLOW_UNKNOWN=false` turns them away too.
- If the lookup is down, the number goes through to the texted code rather than closing
  signups. The texted code is still the real check.
- The line type is stored on the account (`phone_line_type`) for later risk review.
- Twilio's geo permissions (in DEPLOY.md) remain the main defence against SMS fraud costs.

### Invisible challenge

- `lib/human-check.ts` defines a `HumanChallenge` interface with three implementations:
  Cloudflare Turnstile (when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set), a
  development bypass (no keys, not production) and a closed one (no keys in production).
  Decided 17 Nov: production stays closed until the keys are added. The signup page then shows
  "Signups aren't open yet" instead of the form, and the server refuses any signup that is
  posted anyway. The same holds while Twilio Verify isn't set up.
- The widget runs in "interaction-only" mode, so most people never see it.
- Tokens are checked server-side with the caller's IP and must carry the `signup` action.
  If Cloudflare can't be reached the signup fails closed, because failing open would let bots
  straight in.

### Rate limits

Rule (Sean, 17 Nov): people who share a computer or a connection, like a family, each get
their own account with the full limits of their tier. So vote and question limits count per
account only, never per IP address or browser. On the free tier that is 100 new votes and 10
new questions a day, and any vote can be changed once a day, with no cap on how many votes are
changed. The existing 60-votes-a-minute limit per account stays, as a check on scripts.

Per-IP and per-browser limits exist only on starting a signup, as anti-abuse ceilings a
household won't reach:

- 10 signups an hour and 30 a day per IP address (the hourly one existed already).
- 10 signups a day per browser, counted with a random id in a first-party cookie
  (`bm_device`) that identifies the browser, not the person.
- Texted codes stay limited per phone number and per IP, as before.

## Signing up and signing in

Decided by Sean on 17 Nov:

- **Required at signup:** phone number (texted code) and date of birth. These are the human
  and adult checks.
- **Optional at signup:** username and password. A blank username becomes a generated one
  like `quiet_harbor42`, changeable once a day in Settings → Security. Without a password, the
  account signs in by passkey or texted code.
- **Terms:** no tick box. The line "By continuing, you agree to the terms and privacy policy…"
  sits right above the Continue button, with both linked. The account records the terms
  version (`terms_version`, set from `TERMS_VERSION` in `lib/legal.ts`) and the time
  (`consented_at`). US courts generally uphold this "sign-in wrap" when the notice is clear and
  next to the button; it is worth a line in the lawyer review the legal pages already wait on.

Ways in, in the order the sign-in page offers them:

1. **Passkey.** Face ID, Touch ID, a fingerprint, Windows Hello or a security key. The
   biometric check happens on the device; the server only ever sees a signature and keeps a
   public key. User verification is required, so a passkey counts as two factors (the device
   plus the face, finger or device PIN) and needs no further step. New accounts land on the
   Security page, which offers a passkey first. Passkeys are bound to the domain, so ones made
   on a Vercel preview address only work there.
2. **Texted code** to the account's phone. The form answers the same way whether or not the
   number has an account, and only texts numbers that do.
3. **Password**, for accounts that added one.

**Authenticator app (TOTP).** Optional second step after a texted code or password: six-digit
codes from Google Authenticator, 1Password, Authy or the iPhone Passwords app. The secret is
encrypted at rest (AES-256-GCM, key derived from the server's existing `PHONE_PEPPER`). Each
code works once. Setup gives ten single-use recovery codes, stored hashed.

**Account PIN.** 4 to 8 digits, not a repeated digit or a straight run. Asked for before
removing a passkey, turning off the authenticator app, changing the password or deleting the
account. Accounts without a PIN use their password; accounts with neither are asked to set a
PIN first. Stored with scrypt after keying with the server pepper, so a database copy alone
can't be used to guess PINs, and limited to 5 tries per 15 minutes.

**Face scan.** A liveness and ID check needs a paid vendor, so `lib/identity-verification.ts`
defines the interface (start a hosted check, accept the vendor's signed result) with only a
disabled implementation. We would keep that a check passed, when and with which vendor; never
face images, document images or biometric templates.

## Money

Sean's rule (17 Nov): no paid services for now. Anything dealing with money can be built as
far as it goes, but no secrets, keys, access or bank details are put in the code or collected
from users until a payment plan is in place.

- Twilio (texted codes, line-type lookup) runs only with `TWILIO_ENABLED=true`, and Stripe
  (membership) only with `STRIPE_ENABLED=true`, even if keys are present. Both flags are off.
- A scan of every commit on every branch found no real keys. The only key-like strings are
  obvious fakes in the tests (`sk_test_123`, `whsec_test_secret`, `AC_test`) and the
  placeholders in `.env.example`, which holds no values.
- Production signups stay closed until Turnstile (free) and Twilio Verify are both on, which
  in practice means until texting is paid for.

## Planned for the native apps

The web can't call any of these; they need the iOS and Android apps.

- **Declared Age Range (iOS).** Ask for the 18 threshold at signup. A "18 or over" answer
  records `age_method = 'declared_age_range'` and skips the date of birth. A refusal or an
  "under 18" falls back to, or is blocked like, the web flow. Check what the response says
  about how the age was established (self-declared or confirmed) before treating it as
  stronger than our own date check.
- **Play Age Signals (Android).** The same role on Android. It is new and has been rolling out
  region by region, so it will need the date-of-birth fallback for some time.
- **App Attest (iOS) and Play Integrity (Android).** Each request from the app carries proof
  that it came from our unmodified app on a real device. This replaces Turnstile inside the
  apps, where a web widget doesn't fit.
- The apps reuse the same server checks: phone code, line-type lookup, rate limits.

## Options for later

- **Digital Credentials API (web).** Lets a browser ask a phone wallet for one claim from a
  government ID, such as "over 18", without seeing the birthday. Chrome and Safari have begun
  shipping it; which IDs and states work varies. It needs a verifier for the returned
  credential (a library or a vendor). Good fit for a stronger web age check once support is
  wider.
- **The "verified" tier.** The existing optional verified tier, with location, is where a paid
  ID document and selfie check belongs. It also answers the one case the other layers can't:
  one person holding several real SIM cards.

## What needs a decision or an account

- **Cloudflare (free):** decided to keep production signups closed until the two Turnstile
  keys are added.
- **Twilio Lookup (paid per lookup):** switch on with `PHONE_LINE_CHECK=twilio` once Twilio is
  set up. Recommended before launch.
- **Whether unknown line types pass:** default is yes.
- **Native apps:** Declared Age Range, Play Age Signals, App Attest and Play Integrity wait
  for the apps.
- **A vendor for the verified tier:** only if and when that tier launches.

Prices above are approximate list prices from the providers' public pages and should be
checked before budgeting.
