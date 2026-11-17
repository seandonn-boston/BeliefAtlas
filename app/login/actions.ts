"use server";

import { redirect } from "next/navigation";
import { startSession } from "@/lib/auth";
import { finishCodeLogin, startCodeLogin } from "@/lib/code-login";
import { clientIp } from "@/lib/request";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const safeNext = (next: string) => (next.startsWith("/") && !next.startsWith("//") ? next : "/");
const withError = (path: string, message: string) =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;

export async function startCodeLoginAction(form: FormData) {
  const next = safeNext(str(form, "back"));
  const result = await startCodeLogin(str(form, "phone"), next, await clientIp());
  if (!result.ok) redirect(withError(`/login?next=${encodeURIComponent(next)}`, result.error));
  redirect(`/login/code?t=${result.token}`);
}

export async function finishCodeLoginAction(form: FormData) {
  const token = str(form, "token");
  const result = await finishCodeLogin(token, str(form, "code"));
  if (!result.ok) redirect(result.restart ? withError("/login", result.error) : withError(`/login/code?t=${token}`, result.error));
  await startSession(result.accountId);
  redirect(safeNext(result.next));
}
