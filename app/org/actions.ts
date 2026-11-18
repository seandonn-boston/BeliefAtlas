"use server";

import { notFound, redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { orgAccountsEnabled } from "@/lib/headless/config";
import { orgBillingPortal, startOrgCheckout } from "@/lib/headless/org-billing";
import {
  addMember, createOrgForAccount, createOrgPlacement, issueOrgKey, orgForMember, revokeOrgKey, rotateOrgKey, setMember,
  setPlacementOn, updateOrgPlacement, type OrgError, type OrgRole, type PlacementInput,
} from "@/lib/headless/orgs";

// /org's forms. Every action checks the switch, the sign-in and the person's role in that org
// again; the page hiding a button is never the check.

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

async function signedIn(next: string) {
  if (!orgAccountsEnabled()) notFound();
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(next)}`);
  return account;
}

async function member(form: FormData) {
  const slug = str(form, "org");
  const account = await signedIn(`/org/${slug}`);
  const org = await orgForMember(slug, account.id);
  if (!org) notFound();
  return { account, org };
}

const to = (slug: string, param: "saved" | "error", value: string, hash = ""): never =>
  redirect(`/org/${encodeURIComponent(slug)}?${param}=${encodeURIComponent(value)}${hash}`);
const result = (slug: string, r: { ok: true } | { ok: false; error: OrgError }, saved: string, hash: string): never =>
  r.ok ? to(slug, "saved", saved, hash) : to(slug, "error", r.error, hash);

export async function createOrgAction(form: FormData) {
  const account = await signedIn("/org");
  const r = await createOrgForAccount(account, { name: str(form, "name"), slug: str(form, "slug"), country: str(form, "country") });
  if (!r.ok) redirect(`/org?error=${r.error}`);
  to(r.slug, "saved", "created");
}

export async function addMemberAction(form: FormData) {
  const { org } = await member(form);
  result(org.slug, await addMember(org, str(form, "username"), form.get("admin") === "on" ? "admin" : "member"), "member", "#members");
}

export async function setMemberAction(form: FormData) {
  const { org } = await member(form);
  const change = str(form, "change");
  if (!["admin", "member", "remove"].includes(change)) to(org.slug, "error", "not_found", "#members");
  result(org.slug, await setMember(org, Number(str(form, "account")), change as OrgRole | "remove"), "member", "#members");
}

const placementInput = (form: FormData): PlacementInput => ({
  label: str(form, "label"),
  kind: str(form, "kind"),
  origins: str(form, "origins"),
  questions: str(form, "questions"),
  notChildDirected: form.get("notChildDirected") === "on",
});

export async function savePlacementAction(form: FormData) {
  const { org } = await member(form);
  const id = str(form, "placement");
  const r = id ? await updateOrgPlacement(org, id, placementInput(form)) : await createOrgPlacement(org, placementInput(form));
  result(org.slug, r.ok ? { ok: true } : r, "placement", "#placements");
}

export async function switchPlacementAction(form: FormData) {
  const { org } = await member(form);
  result(org.slug, await setPlacementOn(org, str(form, "placement"), str(form, "to") === "on"), "placement", "#placements");
}

export type KeyState = { key?: string; error?: OrgError };

// The new key comes back to the page once, in the form's state, never in an address or a cookie.
export async function issueKeyAction(_prev: KeyState, form: FormData): Promise<KeyState> {
  const { account, org } = await member(form);
  const r = await issueOrgKey(org, account, { label: str(form, "label"), scopes: form.getAll("scope").map(String) });
  return r.ok ? { key: r.key.key } : { error: r.error };
}

export async function rotateKeyAction(_prev: KeyState, form: FormData): Promise<KeyState> {
  const { account, org } = await member(form);
  const r = await rotateOrgKey(org, account, Number(str(form, "key")));
  return r.ok ? { key: r.key.key } : { error: r.error };
}

export async function revokeKeyAction(form: FormData) {
  const { account, org } = await member(form);
  result(org.slug, await revokeOrgKey(org, account, Number(str(form, "key"))), "key", "#keys");
}

export async function checkoutAction(form: FormData) {
  const { org } = await member(form);
  const r = await startOrgCheckout(org, str(form, "plan"));
  if ("error" in r) redirect(`/org/${org.slug}?message=${encodeURIComponent(r.error)}#plan`);
  redirect(r.url);
}

export async function orgPortalAction(form: FormData) {
  const { org } = await member(form);
  const r = await orgBillingPortal(org);
  if ("error" in r) redirect(`/org/${org.slug}?message=${encodeURIComponent(r.error)}#plan`);
  redirect(r.url);
}
