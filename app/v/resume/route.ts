import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { HOLD_COOKIE, HOLD_COOKIE_SECONDS } from "@/lib/front-door";
// W4 consent gate: a held tap is claimed only after the 'answering' agreement, and through
// claimHeld(), which keeps "vote privately" on taps held for consent (else claimHeldVote()).
import { claimHeld, consentUrl } from "@/lib/consent/gate";
import { hasAnsweringConsent } from "@/lib/consent/ledger";

// GET /v/resume
//
// Where signup and sign-in send someone who tapped an answer before they had an account. The
// tap is held server-side and its token sits in an httpOnly cookie on the browser that tapped,
// so this address does nothing for anyone else (a crawler, another browser, a forwarded link).
export async function GET() {
  const jar = await cookies();
  const token = jar.get(HOLD_COOKIE)?.value;
  if (!token) redirect("/");
  const account = await getAccount();
  if (!account) redirect(`/signup?next=${encodeURIComponent("/v/resume")}`);
  // W4: the consent step comes before the held tap is claimed (signup and sign-in land here).
  if (!(await hasAnsweringConsent(account.id))) redirect(consentUrl("/v/resume"));

  const outcome = await claimHeld(token, account);
  if (!outcome) {
    jar.delete(HOLD_COOKIE);
    redirect("/");
  }
  if (outcome.outcome !== "limit_reached") jar.delete(HOLD_COOKIE);
  // W4: a tap held again past the daily limit may come back under a new token.
  else jar.set(HOLD_COOKIE, outcome.holdToken, { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: HOLD_COOKIE_SECONDS });
  const params = new URLSearchParams({ done: outcome.outcome });
  if ("message" in outcome && outcome.outcome !== "limit_reached") params.set("error", outcome.message);
  redirect(`/v/${outcome.questionId}?${params}`);
}
