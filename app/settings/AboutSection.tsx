import { getLocale, getTranslations } from "next-intl/server";
import { addChildAction, clearAboutAction, removeChildAction, saveAboutAction } from "@/app/settings/actions";
import { AGE_RANGES, CHILD_AGE_RANGES, CHILD_RELATIONS, getDemographics, listChildren } from "@/lib/demographics";

// Settings › About you: optional details, each clearable. Children are described only as son,
// daughter or child with an age range; the form has no other fields and the server reads no
// others.
export async function AboutSection({ accountId }: { accountId: number }) {
  const [t, locale, about, children] = await Promise.all([
    getTranslations("settings.about"), getLocale(), getDemographics(accountId), listChildren(accountId),
  ]);
  let countryName: string | null = null;
  try {
    countryName = about.country ? new Intl.DisplayNames([locale], { type: "region" }).of(about.country) ?? null : null;
  } catch {
    countryName = null;
  }
  const clear = (field: string) => (
    <form action={clearAboutAction} className="aside-form">
      <input type="hidden" name="field" value={field} />
      <button className="link">{t("clear")}</button>
    </form>
  );

  return (
    <section className="block" id="about">
      <h2>{t("title")}</h2>
      <p className="note">{t("intro")}</p>

      <form action={saveAboutAction} className="form">
        <label>
          {t("age")}
          <select name="ageRange" defaultValue={about.ageRange ?? ""}>
            <option value="">{t("noAnswer")}</option>
            {AGE_RANGES.map((r) => <option key={r} value={r}>{t(`ages.${r}`)}</option>)}
          </select>
        </label>
        <label>
          {t("country")}
          <input name="country" defaultValue={about.country ?? ""} maxLength={2} pattern="[A-Za-z]{2}" autoComplete="country" />
          <span className="field-note">{countryName ? `${countryName} · ` : ""}{t("countryNote")}</span>
        </label>
        <label className="check">
          <input type="checkbox" name="isParent" defaultChecked={about.isParent === true} /> {t("parent")}
        </label>
        <button className="btn">{t("save")}</button>
      </form>
      {about.ageRange && <div>{t("age")}: {t(`ages.${about.ageRange}`)} {clear("ageRange")}</div>}
      {about.country && <div>{t("country")}: {countryName ?? about.country} {clear("country")}</div>}
      {about.isParent && <div>{t("parent")} {clear("isParent")}</div>}

      {about.isParent && (
        <>
          <h3>{t("children")}</h3>
          <p className="note">{t("childrenNote")}</p>
          {children.length ? (
            <ul>
              {children.map((c) => (
                <li key={c.id}>
                  {t("childLine", { relation: t(`relations.${c.relation}`), age: t(`childAges.${c.ageRange}`) })}
                  <form action={removeChildAction} className="aside-form">
                    <input type="hidden" name="id" value={c.id} />
                    <button className="link">{t("remove")}</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">{t("noChildren")}</p>
          )}
          <form action={addChildAction} className="form">
            <label>
              {t("relation")}
              <select name="relation" required defaultValue="">
                <option value="" disabled />
                {CHILD_RELATIONS.map((r) => <option key={r} value={r}>{t(`relations.${r}`)}</option>)}
              </select>
            </label>
            <label>
              {t("childAge")}
              <select name="ageRange" required defaultValue="">
                <option value="" disabled />
                {CHILD_AGE_RANGES.map((r) => <option key={r} value={r}>{t(`childAges.${r}`)}</option>)}
              </select>
            </label>
            <button className="btn">{t("addChild")}</button>
          </form>
        </>
      )}

      {(about.ageRange || about.country || about.isParent !== null) && (
        <form action={clearAboutAction} className="aside-form">
          <input type="hidden" name="field" value="all" />
          <button className="link">{t("clearAll")}</button>
        </form>
      )}
    </section>
  );
}
