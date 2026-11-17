import { getTranslations } from "next-intl/server";

// The strip across the top of every page: BeliefAtlas shows its users' opinions, nothing official.
// It can't be closed, so it is always in plain view.
export async function UnofficialBar() {
  const t = await getTranslations("common.unofficial");
  return (
    <p className="unofficial-bar" role="note">
      <strong>{t("label")}</strong>
      <span>{t("detail")}</span>
    </p>
  );
}
