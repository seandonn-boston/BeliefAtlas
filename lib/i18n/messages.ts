import { DEFAULT_LOCALE, type Locale } from "./locales";

// Message files are split by feature (messages/en/ask.json, messages/en/vote.json, ...) so two
// pieces of work never edit the same file. Each file is one namespace: `t("ask.title")`.
export const NAMESPACES = [
  "common", "header", "feed", "question", "vote", "ask", "map", "auth", "membership", "account",
  // W4: consent, settings and signup.
  "consent", "settings", "signup",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

type Tree = { [key: string]: string | Tree };

function merge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = typeof v === "object" && typeof b === "object" ? merge(b, v) : v;
  }
  return out;
}

async function load(locale: string, ns: string): Promise<Tree> {
  try {
    return (await import(`../../messages/${locale}/${ns}.json`)).default as Tree;
  } catch {
    return {};
  }
}

// Every namespace for a language, with English underneath so a missing key never shows a blank.
export async function loadMessages(locale: Locale): Promise<Record<Namespace, Tree>> {
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      const en = await load(DEFAULT_LOCALE, ns);
      return [ns, locale === DEFAULT_LOCALE ? en : merge(en, await load(locale, ns))] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Namespace, Tree>;
}
