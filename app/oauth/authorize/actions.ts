"use server";

import { redirect } from "next/navigation";
import { aiHeadEnabled } from "@/lib/ai-head/config";
import { approve, checkAuthorizeRequest, denyRedirect } from "@/lib/ai-head/oauth";
import { getAccount } from "@/lib/auth";

const PARAMS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"] as const;

function paramsFrom(form: FormData): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of PARAMS) {
    const v = form.get(k);
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

// "Allow" or "Don't allow" on /oauth/authorize. Everything is checked again here, since the form
// could have been changed in the browser.
export async function authorizeAction(form: FormData) {
  if (!aiHeadEnabled()) redirect("/");
  const params = paramsFrom(form);
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params as Record<string, string>)}`)}`);
  const check = await checkAuthorizeRequest(params);
  if (!check.ok) {
    if ("redirectUri" in check) redirect(denyRedirect(check.redirectUri, check.redirectError, check.state));
    redirect("/");
  }
  if (form.get("decision") !== "allow") {
    redirect(denyRedirect(check.request.redirectUri, "access_denied", check.request.state));
  }
  redirect(await approve(account, check.request));
}
