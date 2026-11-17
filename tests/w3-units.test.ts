// W3, languages: the pieces that need no database. Choosing the text to show, asking in
// Spanish, and the optional self-hosted translator and embeddings providers (off by default).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { embeddingsEnabled, getEmbedder, HttpEmbedder, parseEmbeddings } from "../lib/embeddings/provider";
import { tidyIn, yesNoProblemIn, questionLanguage } from "../lib/i18n/asking";
import { getTranslator, LibreTranslate, machineTranslationEnabled } from "../lib/i18n/machine";
import { applyTranslations, type TextChoice } from "../lib/i18n/questions";

const known = new Map<number, TextChoice>([
  [1, { canonicalText: "Is water wet?", canonicalLang: "en", approved: "¿El agua moja?" }],
  [2, { canonicalText: "Is the sky blue?", canonicalLang: "en", approved: null }],
  [3, { canonicalText: "¿Es el fútbol el mejor deporte?", canonicalLang: "es", approved: null }],
]);

test("an approved translation replaces the text and says which language it is in", () => {
  const [row] = applyTranslations([{ id: 1, text: "Is water wet?", status: "active" }], "es", known);
  assert.equal(row.text, "¿El agua moja?");
  assert.equal(row.lang, "es");
  assert.equal(row.translated, true);
  assert.equal(row.status, "active"); // everything else is kept
});

test("without an approved translation the canonical text and its language are kept", () => {
  const [sky, futbol] = applyTranslations([{ id: 2, text: "Is the sky blue?" }, { id: 3, text: "x" }], "es", known);
  assert.deepEqual([sky.text, sky.lang, sky.translated], ["Is the sky blue?", "en", false]);
  // A row whose text came from somewhere else (a search hit) gets its canonical text back.
  const [back] = applyTranslations([{ id: 2, text: "¿El cielo es azul?", lang: "es-draft" }], "en", known);
  assert.deepEqual([back.text, back.lang], ["Is the sky blue?", "en"]);
  // A Spanish question read in English, with no English translation, stays Spanish.
  const [inEnglish] = applyTranslations([{ id: 3, text: "¿Es el fútbol el mejor deporte?" }], "en", known);
  assert.equal(inEnglish.lang, "es");
  assert.equal(futbol.text, "¿Es el fútbol el mejor deporte?");
});

test("a row already in the reader's language is left alone", () => {
  const [row] = applyTranslations([{ id: 1, text: "Is water wet?", lang: "en" }], "en", known);
  assert.deepEqual([row.text, row.lang, row.translated], ["Is water wet?", "en", false]);
});

test("asking in Spanish: tidied the Spanish way, and open questions refused", () => {
  assert.equal(tidyIn("es", "  los gatos son mejores que los perros  "), "¿Los gatos son mejores que los perros?");
  assert.equal(tidyIn("es", "¿el café es bueno para la salud?"), "¿El café es bueno para la salud?");
  assert.equal(tidyIn("en", "is coffee good for you"), "Is coffee good for you?");
  assert.equal(yesNoProblemIn("es", "¿Los gatos son mejores que los perros?"), null);
  assert.equal(yesNoProblemIn("es", "¿Que llueva mañana es probable?"), null);
  assert.equal(yesNoProblemIn("es", "¿Qué animal es el mejor de todos?"), "not_yes_no");
  assert.equal(yesNoProblemIn("es", "¿Por qué el cielo es azul?"), "not_yes_no");
  assert.equal(yesNoProblemIn("es", "¿Sí?"), "too_short");
  assert.equal(yesNoProblemIn("es", `¿${"muy ".repeat(60)}largo?`), "too_long");
  assert.equal(questionLanguage("es"), "es");
  assert.equal(questionLanguage("xx"), "en");
});

test("machine drafting is off without TRANSLATE_URL", () => {
  assert.equal(machineTranslationEnabled({}), false);
  assert.equal(machineTranslationEnabled({ TRANSLATE_URL: "  " }), false);
  assert.equal(getTranslator({}), null);
  assert.ok(getTranslator({ TRANSLATE_URL: "http://localhost:5000" }) instanceof LibreTranslate);
});

test("meaning-based search is off without EMBEDDINGS_URL", () => {
  assert.equal(embeddingsEnabled({}), false);
  assert.equal(getEmbedder({}), null);
  assert.equal(getEmbedder({ EMBEDDINGS_URL: "http://localhost:8080/v1/embeddings", EMBEDDINGS_MODEL: "e5" })?.model, "e5");
});

test("embedding responses are read in the common self-hosted shapes", () => {
  assert.deepEqual(parseEmbeddings({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, 2), [[1, 2], [3, 4]]);
  assert.deepEqual(parseEmbeddings([[0.5, 0.25]], 1), [[0.5, 0.25]]);
  assert.deepEqual(parseEmbeddings({ embeddings: [[1]] }, 1), [[1]]);
  assert.throws(() => parseEmbeddings({ data: [] }, 1));
  assert.throws(() => parseEmbeddings([["x"]], 1));
});

// A stand-in for a self-hosted service on this machine, to check what is sent.
async function withServer(reply: (body: Record<string, unknown>, path: string) => unknown, fn: (url: string) => Promise<void>) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply(JSON.parse(raw), req.url ?? "")));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("the LibreTranslate client sends the LibreTranslate request shape", async () => {
  let seen: { body?: Record<string, unknown>; path?: string } = {};
  await withServer((body, path) => {
    seen = { body, path };
    return { translatedText: "¿El agua moja?" };
  }, async (url) => {
    assert.equal(await new LibreTranslate(url).translate("Is water wet?", "en", "es"), "¿El agua moja?");
  });
  assert.equal(seen.path, "/translate");
  assert.deepEqual(seen.body, { q: "Is water wet?", source: "en", target: "es", format: "text" });
});

test("the embeddings client sends texts and reads vectors back", async () => {
  await withServer((body) => ({ data: (body.input as string[]).map((s) => ({ embedding: [s.length, 1] })) }), async (url) => {
    assert.deepEqual(await new HttpEmbedder(`${url}/v1/embeddings`).embed(["ab", "abc"]), [[2, 1], [3, 1]]);
  });
});
