// W3, languages, against DATABASE_URL: approved translations reach readers and drafts never do,
// search finds the canonical question through a translation, machine drafts stay off without a
// translator, and only moderators, admins and translators can review. Cleans up after itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Account, Role } from "../lib/auth";
import { toCard } from "../lib/cards";
import { pool, query } from "../lib/db";
import { indexEmbeddings, meaningMatches, type Embedder } from "../lib/embeddings";
import { draftMachineTranslations } from "../lib/i18n/machine";
import { localizeQuestion, localizeQuestions } from "../lib/i18n/questions";
import {
  approve, canReview, grantTranslator, reject, reviewLanguages, reviewQueue, saveDraft, withdraw,
} from "../lib/i18n/review";
import { beliefMap } from "../lib/map";
import { normalize, search } from "../lib/questions";
import { vote } from "../lib/vote-engine";

const tag = `w3${Date.now().toString(36)}`;
const ids: Record<"lighthouse" | "bridge" | "plain" | "spanish", number> = { lighthouse: 0, bridge: 0, plain: 0, spanish: 0 };
let moderator: Account, admin: Account, translator: Account, reader: Account;

async function makeAccount(name: string, role: Role = "user"): Promise<Account> {
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier, role)
     values ($1, $2, 'x', now(), 'paid', $3) returning id`,
    [`${tag}_${name}`, `${tag}_${name}`, role],
  );
  return { id: row.id, username: `${tag}_${name}`, tier: "paid", verified: false, role };
}

async function makeQuestion(text: string, lang = "en"): Promise<number> {
  const [row] = await query<{ id: number }>(
    "insert into questions (text, normalized, category, status, lang) values ($1, $2, 'general', 'active', $3) returning id",
    [text, normalize(text), lang],
  );
  return row.id;
}

before(async () => {
  moderator = await makeAccount("mod", "moderator");
  admin = await makeAccount("admin", "admin");
  translator = await makeAccount("tr");
  reader = await makeAccount("reader");
  await grantTranslator(translator.id, "es", moderator.id);
  ids.lighthouse = await makeQuestion(`Is the ${tag} lighthouse taller than the old church?`);
  ids.bridge = await makeQuestion(`Is the ${tag} stone bridge older than the town hall?`);
  ids.plain = await makeQuestion(`Is the ${tag} harbour deeper than the river mouth?`);
  ids.spanish = await makeQuestion(`¿Es el mercado ${tag} más antiguo que la catedral?`, "es");
});

after(async () => {
  await query("delete from questions where id = any($1::int[])", [Object.values(ids)]);
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

const SPANISH_LIGHTHOUSE = `¿Es el faro ${tag} más alto que la iglesia vieja?`;
const SPANISH_BRIDGE = `¿Es el puente de piedra ${tag} más viejo que el ayuntamiento?`;

test("only moderators, admins and translators can review, and translators only their languages", async () => {
  assert.deepEqual(await reviewLanguages(moderator), ["en", "es"]);
  assert.deepEqual(await reviewLanguages(admin), ["en", "es"]);
  assert.deepEqual(await reviewLanguages(translator), ["es"]);
  assert.deepEqual(await reviewLanguages(reader), []);
  assert.deepEqual(await reviewLanguages(null), []);
  assert.equal(await canReview(translator, "es"), true);
  assert.equal(await canReview(translator, "en"), false);
  assert.equal(await canReview(moderator, "xx"), false);

  // A plain account can't draft, approve, reject or withdraw anything.
  assert.deepEqual(await saveDraft(reader, ids.plain, "es", "¿Es el puerto más hondo?"), { ok: false, error: "forbidden" });
  assert.deepEqual(await approve(reader, ids.plain, "es", "¿Es el puerto más hondo?"), { ok: false, error: "forbidden" });
  assert.deepEqual(await reject(reader, ids.plain, "es"), { ok: false, error: "forbidden" });
  assert.deepEqual(await withdraw(reader, ids.plain, "es"), { ok: false, error: "forbidden" });
  assert.deepEqual(await saveDraft(translator, ids.spanish, "en", "Is the market older?"), { ok: false, error: "forbidden" });
  assert.equal((await query("select 1 from question_translations where question_id = $1", [ids.plain])).length, 0);

  // A question can't be translated into its own language.
  assert.deepEqual(await saveDraft(moderator, ids.spanish, "es", "¿Otra cosa?"), { ok: false, error: "same_language" });

  // '*' covers every language.
  await grantTranslator(reader.id, "*");
  assert.deepEqual(await reviewLanguages(reader), ["en", "es"]);
  await query("delete from translator_grants where account_id = $1", [reader.id]);
});

test("an approved translation is shown to readers, with who drafted and reviewed it recorded", async () => {
  assert.deepEqual(await saveDraft(translator, ids.lighthouse, "es", `  ${SPANISH_LIGHTHOUSE}  `), { ok: true });
  assert.deepEqual(await approve(moderator, ids.lighthouse, "es"), { ok: true });
  const [row] = await query<{ status: string; source: string; drafted_by: number; reviewed_by: number; reviewed_at: Date | null; text: string }>(
    "select status, source, drafted_by, reviewed_by, reviewed_at, text from question_translations where question_id = $1 and lang = 'es'",
    [ids.lighthouse],
  );
  assert.equal(row.status, "approved");
  assert.equal(row.source, "human");
  assert.equal(row.text, SPANISH_LIGHTHOUSE);
  assert.equal(row.drafted_by, translator.id);
  assert.equal(row.reviewed_by, moderator.id);
  assert.ok(row.reviewed_at);

  const shown = await localizeQuestion({ id: ids.lighthouse, text: "canonical", status: "active" }, "es");
  assert.deepEqual([shown.text, shown.lang, shown.translated], [SPANISH_LIGHTHOUSE, "es", true]);
  // A feed card carries the language for its `lang` attribute.
  const card = toCard({ ...shown, category: "general", t: 0, f: 0, u: 0 }, null);
  assert.equal(card.text, SPANISH_LIGHTHOUSE);
  assert.equal(card.lang, "es");

  // English readers still see the canonical text.
  const english = await localizeQuestion({ id: ids.lighthouse, text: "anything" }, "en");
  assert.deepEqual([english.text, english.lang], [`Is the ${tag} lighthouse taller than the old church?`, "en"]);

  // It leaves the queue's to-do list and shows under Approved; an approved one can't be edited
  // in place, only sent back to drafts.
  assert.deepEqual(await saveDraft(moderator, ids.lighthouse, "es", "otra"), { ok: false, error: "already_approved" });
  const approvedTab = await reviewQueue("es", "approved", 0, 200);
  assert.ok(approvedTab.items.some((i) => i.id === ids.lighthouse && i.translation?.reviewedBy === moderator.username));
});

test("a draft is never shown to readers, and a rejected one neither", async () => {
  assert.deepEqual(await saveDraft(translator, ids.bridge, "es", SPANISH_BRIDGE), { ok: true });
  const draft = await localizeQuestion({ id: ids.bridge, text: "x" }, "es");
  assert.deepEqual([draft.text, draft.lang, draft.translated], [`Is the ${tag} stone bridge older than the town hall?`, "en", false]);
  // Nor found by search.
  assert.ok(!(await search(`puente de piedra ${tag} ayuntamiento`)).some((m) => m.id === ids.bridge && m.lang === "es"));
  // It waits in the queue, drafts first.
  const queue = await reviewQueue("es", "todo", 0, 1);
  assert.ok(queue.drafts >= 1);
  assert.equal(queue.items[0].translation?.status, "draft");

  assert.deepEqual(await reject(translator, ids.bridge, "es"), { ok: true });
  const [row] = await query<{ status: string; reviewed_by: number }>(
    "select status, reviewed_by from question_translations where question_id = $1 and lang = 'es'", [ids.bridge],
  );
  assert.deepEqual([row.status, row.reviewed_by], ["rejected", translator.id]);
  assert.equal((await localizeQuestion({ id: ids.bridge, text: "x" }, "es")).lang, "en");

  // Withdrawing an approved translation takes it off readers' screens.
  assert.deepEqual(await approve(moderator, ids.bridge, "es", SPANISH_BRIDGE), { ok: true });
  assert.equal((await localizeQuestion({ id: ids.bridge, text: "x" }, "es")).text, SPANISH_BRIDGE);
  assert.deepEqual(await withdraw(admin, ids.bridge, "es"), { ok: true });
  assert.equal((await localizeQuestion({ id: ids.bridge, text: "x" }, "es")).lang, "en");
});

test("with no translation the canonical text is shown, in its own language", async () => {
  const rows = await localizeQuestions([{ id: ids.plain, text: "x" }, { id: ids.spanish, text: "y" }], "es");
  assert.deepEqual(rows.map((r) => [r.text, r.lang]), [
    [`Is the ${tag} harbour deeper than the river mouth?`, "en"],
    [`¿Es el mercado ${tag} más antiguo que la catedral?`, "es"],
  ]);
  // A Spanish question read in English stays Spanish and says so.
  const inEnglish = await localizeQuestion({ id: ids.spanish, text: "y" }, "en");
  assert.equal(inEnglish.lang, "es");
});

test("a Spanish search finds the canonical English question through its translation", async () => {
  const hits = await search(`faro ${tag} mas alto que la iglesia`);
  const hit = hits.find((m) => m.id === ids.lighthouse);
  assert.ok(hit, "found through the Spanish translation");
  assert.equal(hit.lang, "es");
  assert.equal(hit.text, SPANISH_LIGHTHOUSE);
  assert.equal(hits.filter((m) => m.id === ids.lighthouse).length, 1, "one row per canonical question");
  // The same text typed exactly is recognised as already asked (what ask() checks).
  assert.ok(hits.some((m) => normalize(m.text) === normalize(SPANISH_LIGHTHOUSE)));
  // English searches still work, and give the canonical text.
  const english = (await search(`${tag} lighthouse taller`)).find((m) => m.id === ids.lighthouse);
  assert.equal(english?.lang, "en");
});

test("your map shows answers in the reader's language", async () => {
  await vote({ account: reader, questionId: ids.lighthouse, value: "true", surface: "web" });
  await vote({ account: reader, questionId: ids.plain, value: "false", surface: "web" });
  const map = await beliefMap(reader.id, { locale: "es" });
  const byId = new Map(map.entries.map((e) => [e.questionId, e]));
  assert.deepEqual([byId.get(ids.lighthouse)?.text, byId.get(ids.lighthouse)?.lang], [SPANISH_LIGHTHOUSE, "es"]);
  assert.equal(byId.get(ids.plain)?.lang, "en");
  assert.equal((await beliefMap(reader.id, { locale: "en" })).entries.find((e) => e.questionId === ids.lighthouse)?.lang, "en");
});

test("machine drafting stays off without TRANSLATE_URL, and its drafts wait for a person", async () => {
  const saved = process.env.TRANSLATE_URL;
  delete process.env.TRANSLATE_URL;
  try {
    const off = await draftMachineTranslations({ lang: "es", limit: 5, ids: [ids.plain] });
    assert.deepEqual(off, { enabled: false, created: 0, failed: 0, considered: 0 });
    assert.equal((await query("select 1 from question_translations where question_id = $1", [ids.plain])).length, 0);
  } finally {
    if (saved !== undefined) process.env.TRANSLATE_URL = saved;
  }

  // With a translator (a stand-in here), drafts are written as machine drafts and not shown.
  const fake = { translate: async (text: string) => `¿${text.replace(/\?$/, "")} (es)?` };
  const on = await draftMachineTranslations({ lang: "es", limit: 5, ids: [ids.plain, ids.lighthouse, ids.spanish] }, fake);
  assert.deepEqual(on, { enabled: true, created: 1, failed: 0, considered: 1 }); // lighthouse has one, spanish is Spanish
  const [row] = await query<{ status: string; source: string; drafted_by: number | null }>(
    "select status, source, drafted_by from question_translations where question_id = $1 and lang = 'es'", [ids.plain],
  );
  assert.deepEqual(row, { status: "draft", source: "machine", drafted_by: null });
  assert.equal((await localizeQuestion({ id: ids.plain, text: "x" }, "es")).lang, "en");
  // Running again leaves it alone.
  assert.equal((await draftMachineTranslations({ lang: "es", ids: [ids.plain] }, fake)).created, 0);
  // A person approves it unchanged: it goes live and stays marked as machine-drafted.
  const [{ text }] = await query<{ text: string }>("select text from question_translations where question_id = $1 and lang = 'es'", [ids.plain]);
  assert.deepEqual(await approve(translator, ids.plain, "es", text), { ok: true });
  const live = await query<{ source: string; reviewed_by: number }>(
    "select source, reviewed_by from question_translations where question_id = $1 and lang = 'es'", [ids.plain],
  );
  assert.deepEqual(live[0], { source: "machine", reviewed_by: translator.id });
  assert.equal((await localizeQuestion({ id: ids.plain, text: "x" }, "es")).text, text);
});

test("meaning-based search is off by default and finds canonical ids when a provider is set", async () => {
  assert.deepEqual(await meaningMatches("anything", 5, null), []);
  assert.deepEqual(await indexEmbeddings({}, null), { enabled: false, indexed: 0, failed: 0 });

  // A stand-in provider whose vectors mark which of our questions a text is about.
  const model = `${tag}-test`;
  const axis = (text: string) => (/lighthouse|faro/i.test(text) ? [1, 0, 0] : /harbour|puerto/i.test(text) ? [0, 1, 0] : [0, 0, 1]);
  const fake: Embedder = { model, embed: async (texts) => texts.map(axis) };
  for (const id of [ids.lighthouse, ids.plain]) {
    const [q] = await query<{ text: string; lang: string }>("select text, lang from questions where id = $1", [id]);
    await query(
      "insert into question_embeddings (question_id, lang, model, embedding, source_text) values ($1, $2, $3, $4::real[], $5)",
      [id, q.lang, model, axis(q.text), q.text],
    );
  }
  const found = await meaningMatches("¿La torre de luz es más alta que el templo? (faro)", 5, fake);
  assert.equal(found[0]?.id, ids.lighthouse);
  // A vector made from text that has since changed doesn't count.
  await query("update question_embeddings set source_text = 'old words' where question_id = $1 and model = $2", [ids.lighthouse, model]);
  assert.ok(!(await meaningMatches("faro", 5, fake)).some((m) => m.id === ids.lighthouse));
  await query("delete from question_embeddings where model = $1", [model]);
});
