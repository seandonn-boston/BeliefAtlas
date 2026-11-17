"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAccount } from "@/lib/auth";
import { APPEAL_MAX, fileAppeal, isAppealSubject } from "@/lib/moderation";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export async function appealAction(form: FormData) {
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent("/appeals")}`);
  const subject = str(form, "subject");
  const subjectId = Number(str(form, "subjectId"));
  const t = await getTranslations("appeals.errors");
  if (!isAppealSubject(subject) || !Number.isInteger(subjectId) || subjectId <= 0) {
    redirect(`/appeals?error=${encodeURIComponent(t("not_yours"))}`);
  }
  const result = await fileAppeal(account.id, subject, subjectId, String(form.get("body") ?? ""));
  if (!result.ok) redirect(`/appeals?error=${encodeURIComponent(t(result.error, { max: APPEAL_MAX }))}`);
  redirect("/appeals?sent=1");
}
