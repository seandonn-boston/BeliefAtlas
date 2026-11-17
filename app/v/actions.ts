"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { cleanPlacement, cleanSurface, HOLD_COOKIE, HOLD_COOKIE_SECONDS, readShownToken } from "@/lib/front-door";
import { CHOICES, type Choice } from "@/lib/vote-engine";
// W4 consent gate: answers count only after the 'answering' agreement (lib/consent/gate.ts).
import { consentUrl, voteWithConsent } from "@/lib/consent/gate";
import { requestContext } from "@/lib/consent/request";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

// A real tap on the one-tap vote page (or in the popup an embed opens). Opening a link never
// gets here: only a form post does, so mail scanners and link previews can't cast votes.
export async function tapAction(form: FormData) {
  const questionId = Number(str(form, "questionId"));
  const value = str(form, "value") as Choice;
  const via = cleanSurface(str(form, "via"));
  const at = cleanPlacement(str(form, "at"));
  const shown = str(form, "shown");
  const popup = str(form, "popup") === "1";
  const page = (extra: Record<string, string>) => {
    const params = new URLSearchParams({
      ...(via !== "web" ? { via } : {}), ...(at ? { at } : {}), ...(popup ? { popup: "1" } : {}), ...extra,
    });
    return `/v/${questionId}?${params}`;
  };
  if (!Number.isInteger(questionId) || questionId <= 0 || !CHOICES.includes(value)) redirect("/");

  const account = await getAccount();
  const outcome = await voteWithConsent({
    account,
    questionId,
    value,
    surface: via,
    placement: at,
    shownAt: readShownToken(shown, questionId),
    // One rendered page, one answer: a double tap or a resubmitted form changes nothing.
    idempotencyKey: shown ? `page:${shown}` : null,
  }, await requestContext(via));

  const jar = await cookies();
  const hold = (token: string) =>
    jar.set(HOLD_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: HOLD_COOKIE_SECONDS });

  switch (outcome.outcome) {
    case "needs_signup":
      // Signing up (or signing in) brings them back to /v/resume, which counts the held tap.
      hold(outcome.holdToken);
      return redirect(`/signup?next=${encodeURIComponent("/v/resume")}`);
    case "needs_consent":
      // W4: held until they agree on /consent, which then counts it through /v/resume.
      hold(outcome.holdToken);
      return redirect(consentUrl("/v/resume", via));
    case "limit_reached":
      hold(outcome.holdToken);
      return redirect(page({ done: "limit_reached" }));
    case "cast":
    case "same":
    case "changed":
    case "skipped":
      return redirect(page({ done: outcome.outcome }));
    default:
      return redirect(page({ done: outcome.outcome, error: outcome.message }));
  }
}
