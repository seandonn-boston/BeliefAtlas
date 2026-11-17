// Question checks: every finding says why, where, and what to change (lib/checks).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTrueFalse, checkQuestion, tidyQuestion } from "../lib/checks";

const at = (text: string, span: { start: number; end: number } | null) => (span ? text.slice(span.start, span.end) : null);

test("links are blocked, written out or disguised, and the suggestion drops them with their pointer word", () => {
  for (const [q, link, suggestion] of [
    ["Did the NYT report this at nytimes.com/2026/x", "nytimes.com/2026/x", "Did the NYT report this?"],
    ["Is this true https://bit.ly/abc", "https://bit.ly/abc", "Is this true?"],
    ["Is the article on cnn dot com accurate", "cnn dot com", "Is the article accurate?"],
    ["Is www.example.org a real site", "www.example.org", null],
  ] as const) {
    const r = checkQuestion(q);
    assert.equal(r.blocked, true, q);
    const found = r.results.find((x) => x.code === "link");
    assert.ok(found, q);
    assert.equal(at(r.text, found.span), link);
    assert.ok(found.reason.length > 20);
    if (suggestion) assert.equal(r.suggestion, suggestion);
  }
});

test("naming a source in words, versions and decimals are not links", () => {
  for (const q of ["Is Node.js faster than Python", "Is pi bigger than 3.14", "Did the New York Times report that the moon is hollow"]) {
    assert.equal(checkQuestion(q).results.filter((r) => r.code === "link").length, 0, q);
  }
});

test("personal details are blocked and pointed at", () => {
  const r = checkQuestion("Is my neighbour at 12 Elm Street a spy");
  assert.equal(r.blocked, true);
  assert.equal(at(r.text, r.results[0].span), "12 Elm Street");
  assert.equal(r.suggestion, "Is my neighbour a spy?");
  const email = checkQuestion("Should people email me at someone@example.com");
  assert.deepEqual(email.results.map((x) => x.code), ["personal_data"]);
});

test("statements and open questions block, with a true/false rewrite where one exists", () => {
  const statement = checkQuestion("The earth is flat");
  assert.equal(statement.blocked, true);
  assert.equal(statement.results[0].code, "not_true_false");
  assert.equal(statement.suggestion, "Is the earth flat?");
  const open = checkQuestion("What causes rain");
  assert.equal(open.blocked, true);
  assert.equal(open.suggestion, null);
  assert.match(open.results[0].reason, /explanation/);
  assert.equal(asTrueFalse("Paris is the capital of France"), "Is Paris the capital of France?");
  assert.equal(asTrueFalse("Vaccines cause autism"), "Is it true that Vaccines cause autism?");
});

test("spelling and repeated words are suggestions only, never blocks", () => {
  const typo = checkQuestion("Is teh earth flat");
  assert.equal(typo.blocked, false);
  assert.equal(typo.suggestion, "Is the earth flat?");
  assert.equal(at(typo.text, typo.results[0].span), "teh");
  const twice = checkQuestion("is the the moon made of cheese");
  assert.equal(twice.blocked, false);
  assert.equal(twice.suggestion, "Is the moon made of cheese?");
  const clean = checkQuestion("Is the moon made of cheese?");
  assert.deepEqual(clean.results, []);
  assert.equal(clean.suggestion, null);
});

test("too short and too long are explained", () => {
  assert.equal(checkQuestion("Cats").results[0].code, "too_short");
  const long = checkQuestion(`Is the ${Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")} long`);
  assert.ok(long.results.some((r) => r.code === "too_long" && r.blocking));
  assert.equal(tidyQuestion("  is it   raining  ?? "), "Is it raining?");
});
