import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { logoutAction } from "@/app/actions";
import { getAccount } from "@/lib/auth";
import type { View } from "@/lib/view";
import { ViewSwitcher } from "./ViewSwitcher";

type Props = {
  q?: string;
  view?: View;     // pass with `back` on pages that list questions to show the layout switcher
  back?: string;
  focus?: boolean; // put the cursor in the search box, e.g. after "Edit" on a suggested question
};

export async function Header({ q = "", view, back, focus = false }: Props) {
  const [account, t] = await Promise.all([getAccount(), getTranslations("header")]);
  return (
    <header className="header">
      <div className="header-in">
        <div className="topline">
          <Link href="/" className="brand" aria-label={t("home")}>
            Belief<span>Atlas</span>
          </Link>
          <nav>
            {view && back && <ViewSwitcher current={view} back={back} />}
            {account ? (
              <form action={logoutAction} className="who">
                {account.role !== "user" && <Link href="/mod">{t("review")}</Link>}
                <Link href="/me">{t("map")}</Link>
                <Link href="/settings" className="who-name">{account.username}</Link>
                <button className="link">{t("signOut")}</button>
              </form>
            ) : (
              <>
                <Link href="/login">{t("signIn")}</Link>
                <Link href="/signup" className="btn solid small">{t("join")}</Link>
              </>
            )}
          </nav>
        </div>
        <form action="/search" className="search" role="search">
          <input name="q" defaultValue={q} placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")} maxLength={200} required autoFocus={focus} />
          <button className="btn">{t("search")}</button>
        </form>
      </div>
    </header>
  );
}

export function ErrorBanner({ message }: { message?: string }) {
  return message ? <p className="error" role="alert">{message}</p> : null;
}
