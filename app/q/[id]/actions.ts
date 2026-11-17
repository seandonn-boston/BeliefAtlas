"use server";

import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { dismissMergeNotice } from "@/lib/moderation";

// M1: "Keep my answer" on the heads-up after a merge. Only the person's own notice.
export async function keepMergedAnswerAction(form: FormData) {
  const questionId = Number(form.get("questionId"));
  const back = Number.isInteger(questionId) && questionId > 0 ? `/q/${questionId}` : "/";
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(back)}`);
  const noticeId = Number(form.get("noticeId"));
  if (Number.isInteger(noticeId) && noticeId > 0) await dismissMergeNotice(account.id, noticeId);
  redirect(back);
}
