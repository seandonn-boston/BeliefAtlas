"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAccount } from "@/lib/auth";
import { CATEGORIES } from "@/lib/categories";
import {
  aiReview, decide, decideAppeal, decideDuplicate, isHarmKind, isRuleId, reviewSignal, scanForManipulation, type Decision,
  type DuplicateDecision,
} from "@/lib/moderation";

// What moderators do from /mod. Every action checks the role again: the page hiding a button
// is not a permission.

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const positiveInt = (value: string) => {
  const n = Number(value.replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function requireModerator() {
  const account = await getAccount();
  if (!account || account.role === "user") redirect("/");
  return account;
}

async function fail(key: string): Promise<never> {
  const t = await getTranslations("mod.errors");
  redirect(`/mod?error=${encodeURIComponent(t.has(key) ? t(key) : t("incomplete"))}`);
}

export async function moderateAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "questionId"));
  const action = str(form, "action");
  let decision: Decision | null = null;
  if (action === "approve" || action === "archive") decision = { action };
  if (action === "remove") {
    const harm = str(form, "harm");
    const rule = str(form, "rule");
    decision = {
      action, why: str(form, "why"), fix: str(form, "fix"), harm: isHarmKind(harm) ? harm : null,
      rule: isRuleId(rule) && rule.startsWith("deny_") ? rule : null,
    };
  }
  if (action === "duplicate" || action === "suggest_duplicate") {
    const of = positiveInt(str(form, "of"));
    if (of) decision = action === "duplicate" ? { action, of, inverted: str(form, "inverted") === "1" } : { action, of };
  }
  if (action === "category") {
    const match = CATEGORIES.find((c) => c.slug === str(form, "category"));
    if (match) decision = { action, category: match.slug };
  }
  if (!id || !decision) return fail("incomplete");
  const error = await decide(account.id, id, decision);
  if (error) return fail(error);
  redirect(decision.action === "suggest_duplicate" ? `/mod?done=suggested&id=${id}#duplicates` : `/mod?done=question&id=${id}`);
}

// M1: a suspected duplicate pair, decided side by side: not duplicates, merge, or merge inverted.
export async function duplicateAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "pairId"));
  const action = str(form, "action");
  const keep = positiveInt(str(form, "keep"));
  let decision: DuplicateDecision | null = null;
  if (action === "dismiss") decision = { action };
  if ((action === "merge" || action === "merge_inverted") && keep) decision = { action: "merge", inverted: action === "merge_inverted", keep };
  if (!id || !decision) return fail("incomplete");
  const error = await decideDuplicate(account.id, id, decision);
  if (error) return fail(error === "decided" ? "pair_decided" : error);
  redirect(`/mod?done=duplicate&id=${id}#duplicates`);
}

export async function aiReviewAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "questionId"));
  if (!id) return fail("incomplete");
  const error = await aiReview(account.id, id);
  if (error) return fail(error);
  redirect(`/mod?done=ai&id=${id}`);
}

export async function decideAppealAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "appealId"));
  const outcome = str(form, "outcome");
  if (!id || (outcome !== "upheld" && outcome !== "overturned")) return fail("incomplete");
  const error = await decideAppeal(account.id, id, outcome, str(form, "note"));
  if (error) return fail(error);
  redirect(`/mod?done=appeal&id=${id}#appeals`);
}

export async function reviewSignalAction(form: FormData) {
  const account = await requireModerator();
  const id = positiveInt(str(form, "signalId"));
  const outcome = str(form, "outcome");
  if (!id || (outcome !== "confirmed" && outcome !== "dismissed")) return fail("incomplete");
  const accounts = form.getAll("ban").map((v) => positiveInt(String(v))).filter((n): n is number => n !== null);
  const result = await reviewSignal(account.id, id, outcome, accounts);
  if (!result.ok) return fail(result.error);
  redirect(`/mod?done=signal&id=${id}&banned=${result.banned}#signals`);
}

export async function scanSignalsAction() {
  await requireModerator();
  const created = await scanForManipulation();
  redirect(`/mod?done=scan&n=${created}#signals`);
}
