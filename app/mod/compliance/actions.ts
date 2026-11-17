"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAccount } from "@/lib/auth";
import { markActionReviewed } from "@/lib/sanctions/ofac-actions";
import { approveParty, refuseParty, resolveHit, ScreeningStale, type DecisionError } from "@/lib/sanctions/screening";

// What moderators and admins do from /mod/compliance. Every action checks the role again: the
// page hiding a button is not a permission.

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const positiveInt = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function requireModerator() {
  const account = await getAccount();
  if (!account || account.role === "user") redirect("/");
  return account;
}

async function fail(key: DecisionError | "incomplete" | "stale"): Promise<never> {
  const t = await getTranslations("compliance.errors");
  redirect(`/mod/compliance?error=${encodeURIComponent(t.has(key) ? t(key) : t("incomplete"))}`);
}

export async function resolveHitAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "hitId"));
  const resolution = str(form, "resolution");
  if (!id || (resolution !== "false_match" && resolution !== "true_match")) return fail("incomplete");
  const error = await resolveHit(id, account.id, resolution, str(form, "note"));
  if (error) return fail(error);
  redirect(`/mod/compliance?done=hit&id=${id}`);
}

export async function approvePartyAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "partyId"));
  if (!id) return fail("incomplete");
  let error: DecisionError | null;
  try {
    error = await approveParty(id, account.id);
  } catch (err) {
    if (err instanceof ScreeningStale) return fail("stale");
    throw err;
  }
  if (error) return fail(error);
  redirect(`/mod/compliance?done=approved&id=${id}`);
}

export async function refusePartyAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "partyId"));
  if (!id) return fail("incomplete");
  const error = await refuseParty(id, account.id, str(form, "reason"));
  if (error) return fail(error);
  redirect(`/mod/compliance?done=refused&id=${id}`);
}

export async function reviewedActionAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "actionId"));
  if (!id) return fail("incomplete");
  if (!(await markActionReviewed(id, account.id))) return fail("not_found");
  redirect(`/mod/compliance?done=reviewed&id=${id}#actions`);
}
