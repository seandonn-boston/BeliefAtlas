"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { safeNext } from "@/lib/consent/context";
import { claimHeld, consentUrl } from "@/lib/consent/gate";
import { honorGpc, recordConsent } from "@/lib/consent/ledger";
import { requestContext } from "@/lib/consent/request";
import { HOLD_COOKIE, HOLD_COOKIE_SECONDS } from "@/lib/front-door";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

function withParam(path: string, key: string, value: string): string {
  const [base, search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  params.delete("error");
  params.delete("voted");
  params.set(key, value);
  return `${base}?${params}`;
}

// "I agree" on /consent. Records the answering agreement for the exact text version shown; the
// sale choice only if its box was ticked (and never with GPC on, where GPC is recorded as an
// opt-out instead). Then the held answer is counted and they go back where they were.
export async function consentAction(form: FormData) {
  const next = safeNext(str(form, "next"));
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(consentUrl(next))}`);
  const ctx = await requestContext(str(form, "via") || "web");

  const answering = await recordConsent(
    { accountId: account.id, choice: "answering", granted: true, version: str(form, "answeringVersion"), lang: str(form, "answeringLang") },
    ctx,
  );
  if (!answering.ok) redirect(withParam(consentUrl(next, ctx.surface), "error", "textChanged"));

  if (ctx.gpc) {
    await honorGpc(account.id, ctx);
  } else if (form.get("sale") === "on") {
    // Refused (and so left off) if the region isn't open to sale; the page never offers it then.
    await recordConsent(
      { accountId: account.id, choice: "sale", granted: true, version: str(form, "saleVersion"), lang: str(form, "saleLang") },
      ctx,
    );
  }

  const jar = await cookies();
  const token = jar.get(HOLD_COOKIE)?.value;
  if (!token) redirect(next);
  if (next.startsWith("/v/resume")) redirect("/v/resume");

  // Count the held answer here and return to the page they tapped on.
  const outcome = await claimHeld(token, account);
  if (!outcome) {
    jar.delete(HOLD_COOKIE);
    redirect(next);
  }
  if (outcome.outcome === "limit_reached") {
    jar.set(HOLD_COOKIE, outcome.holdToken, {
      path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: HOLD_COOKIE_SECONDS,
    });
    redirect(`/v/${outcome.questionId}?done=limit_reached`);
  }
  jar.delete(HOLD_COOKIE);
  if (outcome.outcome === "cast" || outcome.outcome === "same" || outcome.outcome === "changed") {
    redirect(withParam(next, "voted", String(outcome.questionId)));
  }
  redirect("message" in outcome ? withParam(next, "error", outcome.message) : next);
}
