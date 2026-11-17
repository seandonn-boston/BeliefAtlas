import Link from "next/link";
import { useTranslations } from "next-intl";

// The extra proof asked for before a sensitive action: the account PIN if one is set,
// otherwise the password. Accounts with neither are sent to set a PIN.
export function ConfirmFields({ hasPin, hasPassword }: { hasPin: boolean; hasPassword: boolean }) {
  const t = useTranslations("common.confirm");
  if (hasPin) {
    return <label>{t("pin")}<input name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>;
  }
  if (hasPassword) {
    return <label>{t("password")}<input name="password" type="password" autoComplete="current-password" required /></label>;
  }
  return <p className="note">{t.rich("setPin", { link: (c) => <Link href="/settings/security">{c}</Link> })}</p>;
}
