import Link from "next/link";
import { ThemeSwitch } from "./ThemeSwitch";

export function Footer() {
  return (
    <footer className="footer">
      <Link href="/membership">Membership</Link>
      <Link href="/terms">Terms</Link>
      <Link href="/privacy">Privacy</Link>
      <ThemeSwitch />
    </footer>
  );
}
