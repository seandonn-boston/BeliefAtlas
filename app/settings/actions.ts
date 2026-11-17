"use server";

import { redirect } from "next/navigation";
import { getAccount } from "@/lib/auth";
import { currentText, recordConsent } from "@/lib/consent/ledger";
import { requestContext } from "@/lib/consent/request";
import {
  addChild, clearAllDemographics, clearDemographic, DEMOGRAPHIC_FIELDS, removeChild, setDemographics, type DemographicField,
} from "@/lib/demographics";

// The Privacy and About you sections of /settings. Every consent change is a new record (the
// ledger is append-only); every detail about the person can be cleared.

const str = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

async function signedIn() {
  const account = await getAccount();
  if (!account) redirect("/login?next=%2Fsettings");
  return account;
}

const back = (section: string, param: "saved" | "problem", value: string): never =>
  redirect(`/settings?${param}=${encodeURIComponent(value)}#${section}`);

// The one switch for sale. "on" records an opt-in to the exact sale text shown beside the switch
// (refused with GPC on, or where sale isn't open); "off" records the withdrawal, which removes
// them from every sale from then on.
export async function saleChoiceAction(form: FormData) {
  const account = await signedIn();
  const ctx = await requestContext("settings");
  const on = str(form, "to") === "on";
  let version = str(form, "version");
  let lang = str(form, "lang");
  if (!on) {
    const text = await currentText("sale", ctx.lang);
    if (!text) back("privacy", "problem", "unknown_text");
    version = text!.version;
    lang = text!.lang;
  }
  const result = await recordConsent({ accountId: account.id, choice: "sale", granted: on, version, lang }, ctx);
  if (!result.ok) back("privacy", "problem", result.error);
  back("privacy", "saved", on ? "sale_on" : "sale_off");
}

// Withdraw the answering agreement: new answers are held for consent again. (Agreeing again is
// on /consent, which shows the text.)
export async function withdrawAnsweringAction() {
  const account = await signedIn();
  const ctx = await requestContext("settings");
  const text = await currentText("answering", ctx.lang);
  if (!text) back("privacy", "problem", "unknown_text");
  const result = await recordConsent(
    { accountId: account.id, choice: "answering", granted: false, version: text!.version, lang: text!.lang }, ctx,
  );
  if (!result.ok) back("privacy", "problem", result.error);
  back("privacy", "saved", "answering_off");
}

export async function saveAboutAction(form: FormData) {
  const account = await signedIn();
  const result = await setDemographics(account.id, {
    ageRange: str(form, "ageRange") || null,
    country: str(form, "country") || null,
    isParent: form.get("isParent") === "on" ? true : null,
  });
  if (!result.ok) back("about", "problem", result.error);
  back("about", "saved", "about");
}

export async function clearAboutAction(form: FormData) {
  const account = await signedIn();
  const field = str(form, "field");
  if (field === "all") await clearAllDemographics(account.id);
  else if ((DEMOGRAPHIC_FIELDS as readonly string[]).includes(field)) await clearDemographic(account.id, field as DemographicField);
  back("about", "saved", "cleared");
}

// Only the two allowed fields are read from the form, whatever else is posted.
export async function addChildAction(form: FormData) {
  const account = await signedIn();
  const result = await addChild(account.id, { relation: str(form, "relation"), ageRange: str(form, "ageRange") });
  if (!result.ok) back("about", "problem", result.error);
  back("about", "saved", "child_added");
}

export async function removeChildAction(form: FormData) {
  const account = await signedIn();
  const id = Number(str(form, "id"));
  if (Number.isInteger(id) && id > 0) await removeChild(account.id, id);
  back("about", "saved", "child_removed");
}
