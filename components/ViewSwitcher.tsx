import { useTranslations } from "next-intl";
import { setViewAction } from "@/app/actions";
import type { View } from "@/lib/view";

const OPTIONS: { view: View; icon: React.ReactNode }[] = [
  {
    view: "compact",
    icon: <path d="M3 5h14M3 10h14M3 15h14" />,
  },
  {
    view: "tiles",
    icon: (
      <>
        <rect x="3" y="3" width="6" height="8" rx="1" />
        <rect x="11" y="3" width="6" height="5" rx="1" />
        <rect x="3" y="13" width="6" height="4" rx="1" />
        <rect x="11" y="10" width="6" height="7" rx="1" />
      </>
    ),
  },
  {
    view: "swipe",
    icon: (
      <>
        <rect x="5" y="5" width="10" height="10" rx="1.5" />
        <path d="M8 2.5l2-1.5 2 1.5M8 17.5l2 1.5 2-1.5" />
      </>
    ),
  },
];

export function ViewSwitcher({ current, back }: { current: View; back: string }) {
  const t = useTranslations("header");
  return (
    <form action={setViewAction} className="views" aria-label={t("layout")}>
      <input type="hidden" name="back" value={back} />
      {OPTIONS.map((o) => (
        <button key={o.view} name="view" value={o.view} aria-pressed={current === o.view} aria-label={t(`views.${o.view}`)} title={t(`views.${o.view}`)}>
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{o.icon}</svg>
        </button>
      ))}
    </form>
  );
}
