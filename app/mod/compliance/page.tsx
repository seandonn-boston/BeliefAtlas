import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ErrorBanner, Header } from "@/components/Header";
import { getAccount } from "@/lib/auth";
import { countryName } from "@/lib/sanctions/normalize";
import { unreviewedCountryActions, type FlaggedAction } from "@/lib/sanctions/ofac-actions";
import { SANCTIONS_SOURCES } from "@/lib/sanctions/parsers";
import { listFreshness, partiesToReview, STALE_HOURS, type PartyForReview } from "@/lib/sanctions/screening";
import { approvePartyAction, refusePartyAction, resolveHitAction, reviewedActionAction } from "./actions";

type Props = { searchParams: Promise<{ error?: string; done?: string; id?: string }> };

// Sanctions screening for moderators and admins: how fresh each list is, parties with possible
// matches to decide, screened parties waiting for approval, and OFAC actions that may touch a
// country programme. Gated exactly like /mod.
export default async function CompliancePage({ searchParams }: Props) {
  const account = await getAccount();
  if (!account || account.role === "user") notFound();
  const { error, done, id } = await searchParams;
  const [lists, parties, actions, t, format] = await Promise.all([
    listFreshness(), partiesToReview(), unreviewedCountryActions(), getTranslations("compliance"), getFormatter(),
  ]);
  const when = (d: Date) => format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const review = parties.filter((p) => p.status === "review");
  const clear = parties.filter((p) => p.status === "clear");
  const doneKeys = ["hit", "approved", "refused", "reviewed"];

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">{t("title")}</h1>
        <p className="note">{t("intro")}</p>
        <p className="note"><Link href="/mod">{t("back")}</Link></p>
        <ErrorBanner message={error} />
        {done && doneKeys.includes(done) && <p className="notice" role="status">{t(`done.${done}`, { id: id ?? "" })}</p>}
        {lists.some((l) => l.stale) && <p className="error" role="alert">{t("stale", { hours: STALE_HOURS })}</p>}

        <h2 className="list-title" id="lists">{t("sections.lists")}</h2>
        {lists.map((l) => (
          <section key={l.list} className="mod-item">
            <p className="mod-meta">
              <strong>{l.label}</strong>
              {l.stale && <>{" · "}{t("lists.stale")}</>}
            </p>
            <p className="mod-meta">
              {l.lastOkAt ? t("lists.lastOk", { when: when(l.lastOkAt), n: l.entryCount ?? 0 }) : t("lists.never")}
            </p>
            {l.lastFailureAt && <p className="mod-why">{t("lists.lastFailure", { when: when(l.lastFailureAt), error: l.lastError ?? "" })}</p>}
          </section>
        ))}

        <h2 className="list-title" id="review">{t("sections.review")}</h2>
        {review.length === 0 && <p className="empty">{t("empty.review")}</p>}
        {review.map((p) => <PartyItem key={p.id} party={p} />)}

        <h2 className="list-title" id="clear">{t("sections.clear")}</h2>
        {clear.length === 0 && <p className="empty">{t("empty.clear")}</p>}
        {clear.map((p) => <PartyItem key={p.id} party={p} />)}

        <h2 className="list-title" id="actions">{t("sections.actions")}</h2>
        {actions.length === 0 && <p className="empty">{t("empty.actions")}</p>}
        {actions.map((a) => <ActionItem key={a.id} action={a} />)}
      </main>
    </>
  );
}

async function PartyItem({ party }: { party: PartyForReview }) {
  const [t, format] = await Promise.all([getTranslations("compliance"), getFormatter()]);
  return (
    <section className="mod-item">
      <p className="mod-meta">
        #{party.id} · {t("party.kind", { kind: party.kind })}
        {" · "}{party.country ? t("party.country", { country: `${countryName(party.country)} (${party.country})` }) : t("party.noCountry")}
        {party.last_screened_at && <>{" · "}{t("party.screened", { when: format.dateTime(new Date(party.last_screened_at), { dateStyle: "medium", timeStyle: "short" }) })}</>}
      </p>
      <h3 className="q-text">{party.name}</h3>
      {party.status_reason && <p className="mod-why">{party.status_reason}</p>}

      {party.hits.map((hit) => (
        <div key={hit.id} className="mod-note">
          <p className="mod-meta">
            {t("hit.line", { list: SANCTIONS_SOURCES[hit.list]?.label ?? hit.list, name: hit.matched_name, score: hit.score.toFixed(2) })}
          </p>
          {hit.programs && hit.programs.length > 0 && <p className="mod-meta">{t("hit.programs", { programs: hit.programs.join(", ") })}</p>}
          <form action={resolveHitAction} className="mod-actions">
            <input type="hidden" name="hitId" value={hit.id} />
            <input name="note" placeholder={t("fields.note")} maxLength={2000} aria-label={t("fields.note")} />
            <button name="resolution" value="false_match" className="btn small">{t("buttons.falseMatch")}</button>
            <button name="resolution" value="true_match" className="btn small">{t("buttons.trueMatch")}</button>
          </form>
        </div>
      ))}

      <form action={approvePartyAction} className="mod-actions">
        <input type="hidden" name="partyId" value={party.id} />
        <button className="btn small" disabled={party.hits.length > 0}>{t("buttons.approve")}</button>
      </form>
      <details>
        <summary>{t("buttons.refuse")}</summary>
        <form action={refusePartyAction} className="form">
          <input type="hidden" name="partyId" value={party.id} />
          <label>
            {t("fields.refuseReason")}
            <textarea name="reason" required maxLength={2000} rows={2} />
          </label>
          <button className="btn small">{t("buttons.refuse")}</button>
        </form>
      </details>
    </section>
  );
}

async function ActionItem({ action }: { action: FlaggedAction }) {
  const t = await getTranslations("compliance");
  return (
    <section className="mod-item">
      <p className="mod-meta">
        <a href={action.url} rel="noopener noreferrer" target="_blank">{t("action.line", { date: action.action_date, title: action.title })}</a>
      </p>
      <form action={reviewedActionAction} className="mod-actions">
        <input type="hidden" name="actionId" value={action.id} />
        <button className="btn small">{t("buttons.reviewed")}</button>
      </form>
    </section>
  );
}
