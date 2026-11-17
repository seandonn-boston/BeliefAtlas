import Link from "next/link";

// The extra proof asked for before a sensitive action: the account PIN if one is set,
// otherwise the password. Accounts with neither are sent to set a PIN.
export function ConfirmFields({ hasPin, hasPassword }: { hasPin: boolean; hasPassword: boolean }) {
  if (hasPin) {
    return <label>Account PIN<input name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" required /></label>;
  }
  if (hasPassword) {
    return <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>;
  }
  return <p className="note">Set an account PIN in <Link href="/settings/security">Security</Link> first.</p>;
}
