// Machine drafts for the translation review queue, from a self-hosted LibreTranslate-compatible
// service. Off unless TRANSLATE_URL is set. Drafts are never shown to readers until a person
// approves them at /translate.
//
//   npm run translate:drafts -- --lang es --limit 50
import { pool } from "../lib/db";
import { isLocale } from "../lib/i18n/locales";
import { draftMachineTranslations, machineTranslationEnabled } from "../lib/i18n/machine";

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main() {
  const lang = arg("lang") ?? "";
  const limit = Number(arg("limit") ?? 50);
  if (!isLocale(lang)) throw new Error("Usage: npm run translate:drafts -- --lang <es|...> [--limit 50]");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a whole number above 0.");
  if (!machineTranslationEnabled()) {
    console.log("Machine drafts are off: set TRANSLATE_URL to a self-hosted LibreTranslate-compatible service to turn them on.");
    return;
  }
  const run = await draftMachineTranslations({ lang, limit });
  console.log(`${run.created} machine drafts written into ${lang} (${run.considered} considered, ${run.failed} failed). Review them at /translate?lang=${lang}.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
