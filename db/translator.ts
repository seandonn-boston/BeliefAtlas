// Let someone review translations for one language (or '*' for every language) at /translate,
// without making them a moderator:
//   npm run translate:grant -- <username> es
//   npm run translate:grant -- <username> es --revoke
// Moderators and admins can already review every language.
import { pool, query } from "../lib/db";
import { grantTranslator, isGrantLang, revokeTranslator } from "../lib/i18n/review";

async function main() {
  const [username, lang, flag] = process.argv.slice(2);
  if (!username || !lang || !isGrantLang(lang)) {
    throw new Error("Usage: npm run translate:grant -- <username> <lang|*> [--revoke]");
  }
  const [account] = await query<{ id: number }>(
    "select id from accounts where username = $1 and deleted_at is null", [username.toLowerCase()],
  );
  if (!account) throw new Error(`No account named ${username}.`);
  if (flag === "--revoke") {
    await revokeTranslator(account.id, lang);
    console.log(`${username} no longer reviews ${lang === "*" ? "every language" : lang}.`);
  } else {
    await grantTranslator(account.id, lang);
    console.log(`${username} can now review ${lang === "*" ? "every language" : lang} at /translate.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
