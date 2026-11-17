// Interface languages: every message in every language formats, keeps the same placeholders as
// English, and the language comes from the browser when nobody has picked one.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { createTranslator } from "next-intl";
import { direction, fromAcceptLanguage, LOCALES } from "../lib/i18n/locales";
import { loadMessages, NAMESPACES } from "../lib/i18n/messages";

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ""): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v] as [string, string]]));
// Every argument and tag a message uses, at any depth (parsed the same way next-intl parses it;
// the parser comes with next-intl).
function args(msg: string): Set<string> {
  const out = new Set<string>();
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      if ("value" in el && typeof el.value === "string" && el.type !== 0) out.add(el.value);
      if ("options" in el) for (const o of Object.values(el.options)) walk(o.value);
      if ("children" in el) walk(el.children);
    }
  };
  walk(parse(msg));
  return out;
}

test("every message file is a known namespace", () => {
  for (const locale of LOCALES) {
    for (const file of readdirSync(`messages/${locale.code}`)) {
      assert.ok((NAMESPACES as readonly string[]).includes(file.replace(/\.json$/, "")), `${locale.code}/${file}`);
    }
  }
});

test("every message formats in every language, with English's placeholders", async () => {
  const english = new Map(Object.entries(await loadMessages("en")).flatMap(([ns, tree]) => flat(tree, `${ns}.`)));
  for (const { code } of LOCALES) {
    const raw = new Map<string, string>();
    for (const ns of NAMESPACES) {
      try {
        flat(JSON.parse(readFileSync(`messages/${code}/${ns}.json`, "utf8")), `${ns}.`).forEach(([k, v]) => raw.set(k, v));
      } catch { /* a missing file falls back to English */ }
    }
    for (const [key, msg] of raw) {
      assert.ok(english.has(key), `${code}: ${key} isn't in English`);
      const want = [...args(english.get(key)!)].sort().join(",");
      const have = [...args(msg)].sort().join(",");
      assert.equal(have, want, `${code}: ${key} placeholders`);
    }
    const messages = await loadMessages(code);
    const t = createTranslator({ locale: code, messages });
    const values = { n: 3, e: "45K", kind: "exact", t: 1, f: 2, u: 3, what: "vote", value: "true", private: "yes", done: "cast" };
    const tag = (chunks: unknown) => chunks;
    for (const [key, msg] of english) {
      const v: Record<string, unknown> = { ...values };
      for (const a of args(msg)) if (!(a in v)) v[a] = "x";
      if (/<\w+>/.test(msg)) {
        for (const m of msg.matchAll(/<(\w+)>/g)) v[m[1]] = tag;
        assert.doesNotThrow(() => t.rich(key as never, v as never), `${code}: ${key}`);
      } else {
        const out = t(key as never, v as never);
        assert.ok(typeof out === "string" && out.length > 0 && !out.includes(key), `${code}: ${key} -> ${out}`);
      }
    }
  }
});

test("the browser's language is used when nobody has chosen one", () => {
  assert.equal(fromAcceptLanguage("es-MX,es;q=0.9,en;q=0.8"), "es");
  assert.equal(fromAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.5"), "en");
  assert.equal(fromAcceptLanguage("en;q=0.2, es;q=0.8"), "es");
  assert.equal(fromAcceptLanguage("de"), null);
  assert.equal(fromAcceptLanguage(""), null);
});

test("right-to-left scripts flip the page", () => {
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("he-IL"), "rtl");
  assert.equal(direction("es"), "ltr");
});
