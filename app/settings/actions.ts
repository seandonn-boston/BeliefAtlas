"use server";

import { redirect } from "next/navigation";
import { getAccount, hashPassword } from "@/lib/auth";
import { query } from "@/lib/db";
import { passwordProblem, usernameProblem } from "@/lib/signup";

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const back = (message?: string) => redirect(message ? `/settings?error=${encodeURIComponent(message)}` : "/settings?saved=1");

// Usernames are generated at signup when none is picked, so they can be changed here.
export async function changeUsernameAction(form: FormData) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings");
  const username = str(form, "username").toLowerCase();
  if (username === account.username) back();
  const problem = usernameProblem(username);
  if (problem) back(problem);
  const updated = await query("update accounts set username = $2 where id = $1 and not exists (select 1 from accounts where username = $2) returning id", [account.id, username]);
  back(updated.length ? undefined : "That username is taken.");
}

// Passwords are optional. An account without one can add one here; changing an existing
// password is not offered yet.
export async function addPasswordAction(form: FormData) {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings");
  const password = String(form.get("password") ?? "");
  if (!password) back("Enter a password.");
  const problem = passwordProblem(password);
  if (problem) back(problem);
  const updated = await query(
    "update accounts set password_hash = $2 where id = $1 and password_hash = '' returning id",
    [account.id, hashPassword(password)],
  );
  back(updated.length ? undefined : "This account already has a password.");
}
