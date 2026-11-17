import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/Header";
import { LegalPage } from "@/components/Legal";
import { CONTACT_EMAIL, OPERATOR } from "@/lib/legal";
import { MIN_GROUP_SIZE } from "@/lib/limits";

export const metadata: Metadata = { title: "Privacy policy · BeliefAtlas" };

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <LegalPage title="Privacy policy">
        <p>
          BeliefAtlas records how people answer true-or-false questions and publishes what the crowd believes. This page
          explains what we keep about you, why, and what you can do about it. It is run by {OPERATOR}.
        </p>

        <h2>What we keep</h2>
        <ul>
          <li>
            <strong>Your username, and a password and PIN if you set them.</strong> Passwords and PINs are stored only
            as one-way hashes.
          </li>
          <li>
            <strong>Passkeys and authenticator apps, if you add them.</strong> For a passkey we keep only its public key;
            your face or fingerprint is checked on your own device and never sent to us. An authenticator app&apos;s
            setup key is stored encrypted.
          </li>
          <li>
            <strong>Your phone number, as a one-way hash.</strong> We use it to allow one account per number. The number
            itself is held for at most 15 minutes while we confirm it, then deleted. We also keep what kind of line it
            is (for example mobile), because virtual numbers can&apos;t be used.
          </li>
          <li>
            <strong>That you are 18 or older,</strong> and how that was checked. Your date of birth is checked when you
            sign up and not kept.
          </li>
          <li>
            <strong>Your votes and every change to them, with the time.</strong> We also note whether you saw the results
            before voting and how you reached the question (for example the home feed or a shared link).
          </li>
          <li><strong>Questions you ask and reports you file.</strong> Questions are always shown without your name.</li>
          <li>
            <strong>Membership status,</strong> if you pay. Card details are handled by Stripe and never reach us; we keep
            only the Stripe customer reference.
          </li>
          <li><strong>When you were last active,</strong> to the nearest hour.</li>
          <li>
            <strong>Your agreements.</strong> Each time you agree to something or change your mind, we keep which choice
            it was, the exact wording you were shown (by version), when, where (for example the home feed or a shared
            link), the country your connection came from, and whether your browser sent a Global Privacy Control signal.
            These records are never edited, only added to, so they are an accurate history.
          </li>
          <li>
            <strong>Details about you, only if you add them:</strong> an age range, a country, whether you are a parent,
            and for each child only son, daughter or child and an age range. Never a child&apos;s name, birth date or
            account. You can clear any of these in <Link href="/settings">Settings</Link>.
          </li>
        </ul>

        <h2>Agreeing before your first answer</h2>
        <p>
          You can read questions and results without agreeing to anything. Your answers say what you believe, which the
          law treats as especially sensitive, so before your first answer counts we ask you to agree, once, to us keeping
          your answers. Until you agree, the answer you tapped is held and not counted. You can withdraw this agreement
          in Settings; after that no new answer of yours counts.
        </p>

        <h2>Selling your answers is off unless you turn it on</h2>
        <p>
          Including your answers in data we sell is a separate choice. It is off unless you tick it, you never need it
          to vote, and you can turn it off at any time in Settings with one switch, which leaves you out of every later
          sale. If your browser sends a Global Privacy Control signal, we treat it as a no and record it. Some countries
          stay closed to sale whatever you choose. Private answers are never sold. Nothing has been sold yet.
        </p>

        <h2>Public and private votes</h2>
        <p>
          Once following is available, people who follow you will see which questions you voted on publicly, but not
          which way you voted. A private vote is never shown with your name to anyone. It is still linked to your account inside our database, because
          that is what lets you change or withdraw it later, and it counts toward results like any other vote.
        </p>

        <h2>What we publish</h2>
        <p>
          We publish results in aggregate: percentages, counts, how often people change their minds, and how
          results move over time. We never publish anything that names you, includes your phone number, or lets
          someone look up how you voted. Breakdowns of fewer than {MIN_GROUP_SIZE} people are withheld so that small
          groups can&apos;t be picked out.
        </p>

        <h2>Who else handles your information</h2>
        <ul>
          <li>
            <strong>Twilio</strong> sends the code that confirms your phone number and may look up what kind of line it
            is.
          </li>
          <li>
            <strong>Cloudflare</strong> runs an invisible check on the signup form that tells people from automated
            scripts.
          </li>
          <li><strong>Stripe</strong> processes membership payments.</li>
          <li><strong>Vercel and Neon</strong> host the site and its database.</li>
          <li>
            <strong>Anthropic</strong> may check the text of new questions for repeats and harmful content. It receives the
            question, never who asked it.
          </li>
        </ul>

        <h2>Cookies</h2>
        <p>
          We only use cookies the site needs to work, so there is no cookie banner: one keeps you signed in, three remember
          your layout, theme and language, one holds an answer you tapped until you sign up or agree, and one holds a
          random id for this browser, used only to limit how many accounts can be made from it. If a date of birth under
          18 is entered, a cookie stops this browser from trying again for a day. There are no advertising or tracking
          cookies.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>Change or withdraw any vote, once per question per day.</li>
          <li>Make a public vote private, or a private vote public.</li>
          <li>Turn selling your answers on or off, and see every choice you have made, in Settings.</li>
          <li>
            Download everything we hold about your account from <Link href="/settings">Settings</Link>.
          </li>
          <li>
            Delete your account from <Link href="/settings">Settings</Link>. Your current votes are withdrawn from every
            result immediately. The dated record of past votes is kept for the historical results, attached to a new
            anonymous record with no username, phone number, password or payment details, so it can no longer be
            connected to you.
          </li>
        </ul>

        <h2>Age</h2>
        <p>
          BeliefAtlas is for adults. You must be 18 or older to create an account, and we ask for your date of birth to
          check.
        </p>

        <h2>Contact</h2>
        <p>Questions about privacy go to {CONTACT_EMAIL}.</p>
      </LegalPage>
    </>
  );
}
