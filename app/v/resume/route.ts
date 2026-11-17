import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { HOLD_COOKIE } from "@/lib/front-door";
import { claimHeldVote } from "@/lib/vote-engine";

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

  const outcome = await claimHeldVote(token, account);
  if (!outcome) {
    jar.delete(HOLD_COOKIE);
    redirect("/");
  }
  if (outcome.outcome !== "limit_reached") jar.delete(HOLD_COOKIE);
  const params = new URLSearchParams({ done: outcome.outcome });
  if ("message" in outcome && outcome.outcome !== "limit_reached") params.set("error", outcome.message);
  redirect(`/v/${outcome.questionId}?${params}`);
}
