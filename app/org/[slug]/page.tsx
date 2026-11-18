import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { keysEnabled, orgAccountsEnabled } from "@/lib/headless/config";
import { listCredentials } from "@/lib/headless/credentials";
import { orgBillingMode } from "@/lib/headless/org-billing";
import { listMembers, listPlacements, orgForMember, type OrgError, type PlacementRow } from "@/lib/headless/orgs";
import { getPlacement, PLACEMENT_KINDS, placementResults } from "@/lib/headless/placements";
import { minGroupSize } from "@/lib/regions";
import {
  addMemberAction, checkoutAction, issueKeyAction, orgPortalAction, revokeKeyAction, rotateKeyAction, savePlacementAction,
  setMemberAction, switchPlacementAction,
} from "../actions";
import { KeyForm } from "./KeyForm";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string; saved?: string; message?: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("org");
  return { title: `${t("metaTitle")} · BeliefAtlas` };
}

// One organization, for its own people: whether it's live, its plan, people, placements with
// their aggregate results, and server keys. Admins change things; members only look.
export default async function OrgPage({ params, searchParams }: Props) {
  if (!orgAccountsEnabled()) notFound();
  const { slug } = await params;
  const account = await getAccount();
  if (!account) redirect(`/login?next=${encodeURIComponent(`/org/${slug}`)}`);
  const org = await orgForMember(slug, account.id);
  if (!org) notFound();
  const [{ error, saved, message }, t, format, members, placements, keys, min] = await Promise.all([
    searchParams, getTranslations("org"), getFormatter(), listMembers(org.id), listPlacements(org.id),
    keysEnabled() ? listCredentials(org.id) : Promise.resolve([]), minGroupSize(),
  ]);
  const admin = org.role === "admin";
  const when = (d: Date) => format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const errorKey = error && t.has(`errors.${error as OrgError}`) ? (error as OrgError) : null;
  const errors = Object.fromEntries(
    (["label", "not_admin", "not_serving", "plan_keys", "plan_relay", "not_found"] as const).map((k) => [k, t(`errors.${k}`)]),
  );
  const billing = orgBillingMode();
  const results = await Promise.all(placements.map(async (p) => {
    const placement = await getPlacement(p.id);
    return placement ? placementResults(placement, min) : [];
  }));
  const statusKey = org.status === "suspended" ? "suspended" : org.screening === "refused" ? "refused" : org.serving ? "serving" : "screening";

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{org.name}</h1>
        <p className="note"><Link href="/org">{t("title")}</Link> · {t("role", { role: org.role })}</p>
        <p className="note">{t("notice")}</p>
        {errorKey && <p className="error" role="alert">{t(`errors.${errorKey}`)}</p>}
        <ErrorBanner message={message} />
        {saved && <p className="notice" role="status">{t("saved", { what: saved })}</p>}

        <section className="block" id="status">
          <h2>{t("status.title")}</h2>
          <p>{t(`status.${statusKey}`)}</p>
          {org.origin === "test" && <p className="note">{t("status.test")}</p>}
        </section>

        <section className="block" id="plan">
          <h2>{t("plan.title")}</h2>
          <p>{t("plan.current", { plan: org.effective.id, placements: org.effective.placements, members: org.effective.members, keys: org.effective.keys })}</p>
          <p className="note">{t("plan.relay", { relay: org.effective.relay ? "yes" : "no" })}</p>
          {org.plan !== org.effective.id && <p className="note">{t("plan.lapsed", { status: org.planStatus ?? "none" })}</p>}
          {billing === "off" && <p className="note">{t("plan.off")}</p>}
          {billing !== "off" && admin && (
            <div className="aside-form">
              {(["pro", "business"] as const).filter((p) => p !== org.effective.id).map((p) => (
                <form key={p} action={checkoutAction}>
                  <input type="hidden" name="org" value={org.slug} />
                  <input type="hidden" name="plan" value={p} />
                  <button className="btn">{t("plan.choose", { plan: p })}</button>
                </form>
              ))}
              {org.effective.id !== "free" && (
                <form action={orgPortalAction}>
                  <input type="hidden" name="org" value={org.slug} />
                  <button className="link">{t("plan.manage")}</button>
                </form>
              )}
            </div>
          )}
        </section>

        <section className="block" id="members">
          <h2>{t("members.title")}</h2>
          <ul>
            {members.map((m) => (
              <li key={m.accountId}>
                {m.username} · {t("role", { role: m.role })}
                {admin && (
                  <form action={setMemberAction} className="aside-form">
                    <input type="hidden" name="org" value={org.slug} />
                    <input type="hidden" name="account" value={m.accountId} />
                    <button className="link" name="change" value={m.role === "admin" ? "member" : "admin"}>
                      {m.role === "admin" ? t("members.makeMember") : t("members.makeAdmin")}
                    </button>
                    <button className="link" name="change" value="remove">{t("members.remove")}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {admin && (
            <form action={addMemberAction} className="form">
              <p className="note">{t("members.intro")}</p>
              <input type="hidden" name="org" value={org.slug} />
              <label>{t("members.username")}<input name="username" required /></label>
              <label><input type="checkbox" name="admin" /> {t("members.asAdmin")}</label>
              <button className="btn">{t("members.add")}</button>
            </form>
          )}
        </section>

        <section className="block" id="placements">
          <h2>{t("placements.title")}</h2>
          <p className="note">{t("placements.intro")}</p>
          {placements.length === 0 && <p className="empty">{t("placements.none")}</p>}
          {placements.map((p, i) => (
            <div key={p.id} className="mod-item">
              <p className="mod-meta">
                <strong>{p.label}</strong> · {t("placements.kinds", { kind: p.kind })}
                {p.disabled_at && <> · {t("placements.isOff")}</>}
              </p>
              <p className="mod-meta">{t("placements.id", { id: p.id })}</p>
              <h3>{t("placements.results")}</h3>
              <ul>
                {results[i].map((r) => (
                  <li key={r.questionId}>
                    {r.enough && r.percentages
                      ? t("placements.split", { id: r.questionId, total: r.total ?? 0, t: r.percentages.true, f: r.percentages.false, u: r.percentages.unsure })
                      : t("placements.tooFew", { id: r.questionId })}
                  </li>
                ))}
              </ul>
              {admin && (
                <>
                  <form action={switchPlacementAction} className="aside-form">
                    <input type="hidden" name="org" value={org.slug} />
                    <input type="hidden" name="placement" value={p.id} />
                    <button className="link" name="to" value={p.disabled_at ? "on" : "off"}>
                      {p.disabled_at ? t("placements.on") : t("placements.off")}
                    </button>
                  </form>
                  <details>
                    <summary>{t("placements.edit")}</summary>
                    <PlacementForm t={t} org={org.slug} placement={p} button={t("placements.save")} />
                  </details>
                </>
              )}
            </div>
          ))}
          {admin && <PlacementForm t={t} org={org.slug} button={t("placements.create")} />}
        </section>

        <section className="block" id="keys">
          <h2>{t("keys.title")}</h2>
          <p className="note">{t("keys.intro")}</p>
          {!keysEnabled() && <p className="note">{t("keys.off")}</p>}
          {keys.map((k) => (
            <div key={k.id} className="mod-item">
              <p className="mod-meta">
                <strong>{k.label}</strong> · <code>{k.lookup}</code> · {k.scopes.map((s) => t(`keys.${s}`)).join(", ")}
              </p>
              <p className="mod-meta">
                {k.revoked_at ? t("keys.revoked") : k.last_used_at ? t("keys.lastUsed", { when: when(k.last_used_at) }) : t("keys.neverUsed")}
                {k.expires_at && !k.revoked_at && <> · {t("keys.expires", { when: when(k.expires_at) })}</>}
              </p>
              {admin && !k.revoked_at && (
                <>
                  <KeyForm action={rotateKeyAction} org={org.slug} hidden={{ key: String(k.id) }} button={t("keys.rotate")} shownOnce={t("keys.shownOnce")} errors={errors} className="aside-form" />
                  <form action={revokeKeyAction} className="aside-form">
                    <input type="hidden" name="org" value={org.slug} />
                    <input type="hidden" name="key" value={k.id} />
                    <button className="link">{t("keys.revoke")}</button>
                  </form>
                </>
              )}
            </div>
          ))}
          {admin && keysEnabled() && (
            <KeyForm action={issueKeyAction} org={org.slug} button={t("keys.issue")} shownOnce={t("keys.shownOnce")} errors={errors}>
              <label>{t("keys.label")}<input name="label" required maxLength={80} /></label>
              <fieldset>
                <legend>{t("keys.scopes")}</legend>
                <label><input type="checkbox" name="scope" value="results" defaultChecked /> {t("keys.results")}</label>
                {org.effective.relay && <label><input type="checkbox" name="scope" value="relay" /> {t("keys.relay")}</label>}
              </fieldset>
            </KeyForm>
          )}
        </section>
      </main>
    </>
  );
}

function PlacementForm({ t, org, placement, button }: {
  t: Awaited<ReturnType<typeof getTranslations<"org">>>; org: string; placement?: PlacementRow; button: string;
}) {
  return (
    <form action={savePlacementAction} className="form">
      <input type="hidden" name="org" value={org} />
      {placement && <input type="hidden" name="placement" value={placement.id} />}
      <label>{t("placements.label")}<input name="label" required maxLength={120} defaultValue={placement?.label} /></label>
      <label>
        {t("placements.kind")}
        <select name="kind" defaultValue={placement?.kind ?? "site"}>
          {PLACEMENT_KINDS.map((k) => <option key={k} value={k}>{t("placements.kinds", { kind: k })}</option>)}
        </select>
      </label>
      <label>{t("placements.origins")}<textarea name="origins" rows={3} defaultValue={placement?.allowed_origins.join("\n")} /></label>
      <label>{t("placements.questions")}<input name="questions" defaultValue={placement?.question_ids.join(", ")} /></label>
      <label><input type="checkbox" name="notChildDirected" required defaultChecked={placement?.not_child_directed} /> {t("placements.attest")}</label>
      <button className="btn">{button}</button>
    </form>
  );
}
