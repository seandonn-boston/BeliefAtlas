import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { saleChoiceAction, withdrawAnsweringAction } from "@/app/settings/actions";
import { consentUrl } from "@/lib/consent/gate";
import {
  CONSENT_DRAFT, consentHistory, consentState, currentText, honorGpc, saleIsOn, saleOffer,
} from "@/lib/consent/ledger";
import { requestContext } from "@/lib/consent/request";

// Settings › Privacy and consent: both choices with the date and text version of the latest
// record, the one switch for sale, and every record ever made.
export async function PrivacySection({ accountId }: { accountId: number }) {
  const ctx = await requestContext("settings");
  // A Global Privacy Control signal is an opt-out of sale: record it before showing the state.
  await honorGpc(accountId, ctx);
  const [t, format, state, history, offer, saleText] = await Promise.all([
    getTranslations("settings.privacy"),
    getFormatter(),
    consentState(accountId),
    consentHistory(accountId),
    saleOffer(accountId, ctx),
    currentText("sale", ctx.lang),
  ]);
  const date = (d: Date) => format.dateTime(d, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const answeringState = state.answering ? (state.answering.granted ? "granted" : "withdrawn") : "never";
  const saleOn = saleIsOn(state);
  const saleState = saleOn ? "on" : state.sale?.gpc ? "gpc" : "off";

  return (
    <section className="block" id="privacy">
      <h2>{t("title")}</h2>
      {CONSENT_DRAFT && <p className="note" role="note">{t("draft")}</p>}
      <p className="note">{t("intro")}</p>

      <dl>
        <div className="settings-row">
          <dt>{t("answering")}</dt>
          <dd>
            {t("answeringState", { state: answeringState })}
            {state.answering && <><br /><span className="field-note">{t("recorded", { date: date(state.answering.createdAt), version: state.answering.textVersion })}</span></>}
          </dd>
        </div>
        <div className="settings-row">
          <dt>{t("sale")}</dt>
          <dd>
            {t("saleState", { state: saleState })}
            {state.sale && <><br /><span className="field-note">{t("recorded", { date: date(state.sale.createdAt), version: state.sale.textVersion })}</span></>}
          </dd>
        </div>
      </dl>

      {state.answering?.granted ? (
        <form action={withdrawAnsweringAction} className="aside-form">
          <span>{t("withdrawNote")}</span>
          <button className="link">{t("withdraw")}</button>
        </form>
      ) : (
        <p className="aside-form"><Link href={consentUrl("/settings")}>{t("agree")}</Link></p>
      )}

      {/* The one switch for sale. Off is always available; on only where it can be honoured. */}
      {saleOn ? (
        <form action={saleChoiceAction} className="aside-form">
          <input type="hidden" name="to" value="off" />
          <span>{t("offNote")}</span>
          <button className="btn">{t("turnOff")}</button>
        </form>
      ) : offer.offer && saleText ? (
        <form action={saleChoiceAction} className="form">
          <input type="hidden" name="to" value="on" />
          <input type="hidden" name="version" value={saleText.version} />
          <input type="hidden" name="lang" value={saleText.lang} />
          <p className="note">{t("onNote")}</p>
          <div className="note" lang={saleText.lang}>
            {saleText.body.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <button className="btn">{t("turnOn")}</button>
        </form>
      ) : (
        <p className="note">{offer.offer ? t("closed") : t(offer.reason === "gpc" ? "gpc" : "closed")}</p>
      )}
      <p className="note">{t("nothingSold")}</p>

      <details>
        <summary>{t("history")}</summary>
        {history.length ? (
          <ul className="note">
            {history.map((r) => (
              <li key={r.id}>
                {t("historyLine", {
                  date: date(r.createdAt), choice: r.choice, granted: r.granted ? "yes" : "no", version: r.textVersion, surface: r.surface,
                })}
                {r.region ? ` ${t("historyRegion", { region: r.region })}` : ""}
                {r.gpc ? ` ${t("historyGpc")}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">{t("historyEmpty")}</p>
        )}
      </details>
    </section>
  );
}
