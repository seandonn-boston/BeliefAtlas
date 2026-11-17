"use server";

import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { approve, reject, saveDraft, withdraw, type ReviewResult } from "@/lib/i18n/review";

const ACTS = ["save", "approve", "reject", "withdraw"] as const;
type Act = (typeof ACTS)[number];

const str = (form: FormData, key: string) => String(form.get(key) ?? "");

// One form per question on /translate; the button pressed says what to do. Every check (who
// may review which language, what may change) is in lib/i18n/review, not here.
export async function translateAction(form: FormData) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Ftranslate");
  const act = str(form, "act") as Act;
  const lang = str(form, "lang");
  const questionId = Number(str(form, "questionId"));
  const tab = str(form, "tab") === "approved" ? "approved" : "todo";
  const page = Math.max(0, Math.floor(Number(str(form, "page")) || 0));

  let result: ReviewResult;
  if (!ACTS.includes(act) || !Number.isInteger(questionId) || questionId <= 0) {
    result = { ok: false, error: "not_found" };
  } else if (act === "save") {
    result = await saveDraft(account, questionId, lang, str(form, "text"));
  } else if (act === "approve") {
    // Approve exactly the words in the box, which may have just been edited.
    result = await approve(account, questionId, lang, str(form, "text"));
  } else if (act === "reject") {
    result = await reject(account, questionId, lang);
  } else {
    result = await withdraw(account, questionId, lang);
  }

  const params = new URLSearchParams({ lang, tab });
  if (page) params.set("page", String(page));
  if (result.ok) {
    params.set("done", act);
    params.set("id", String(questionId));
  } else {
    params.set("error", result.error);
  }
  redirect(`/translate?${params}#q${questionId}`);
}
