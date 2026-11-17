// W2 sweep and checks: the rules-based classifier when a question is asked (allow, hold or
// deny with why, where and a fix), and the optional grammar check that never blocks and stays
// off unless LANGUAGETOOL_URL is set.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "../lib/db";
import { checkQuestion } from "../lib/checks";
import { checkQuestionWithGrammar, grammarCheck, grammarEnabled } from "../lib/checks/grammar";
import { classify, sweep } from "../lib/moderation";

after(async () => {
  await pool.end();
});

const fix = (text: string) => classify(text).results.map((r) => ({ where: r.span ? text.slice(r.span.start, r.span.end) : null, fix: r.fix }));

test("ordinary problems are denied with why, where and a fix, and no harm", () => {
  const swear = classify("Is the new tax law fucking stupid?");
  assert.equal(swear.harm, null);
  assert.equal(swear.results[0].code, "obscene");
  assert.deepEqual(fix("Is the new tax law fucking stupid?"), [{ where: "fucking", fix: "really" }]);
  // Disguised spellings still count.
  assert.equal(classify("Is this whole thing sh1t?").results[0]?.code, "obscene");

  const boss = classify("Is my boss allowed to read my email?");
  assert.equal(boss.harm, null);
  assert.equal(boss.results[0].code, "too_specific");
  assert.equal(boss.results[0].fix, "a boss");
  assert.ok(boss.results.every((r) => r.blocking && r.reason && r.key));

  const self = classify("Should I quit my job to travel?");
  assert.deepEqual(self.results.map((r) => r.fix), ["should people", "their"]);

  // Words with an innocent meaning are left alone.
  for (const ok of ["Is Scunthorpe in England?", "Was Moby Dick a real whale?", "Is fire retardant toxic?", "Is a discount code worth hunting for?"]) {
    assert.deepEqual(classify(ok).results, [], ok);
  }
});

test("harmful questions are denied as harmful: slurs, dehumanising, violence, spam, targeting a private person", () => {
  assert.equal(classify("Are immigrants vermin?").harm, "hateful");
  assert.equal(classify("Is it true that refugees are subhuman?").harm, "hateful");
  assert.equal(classify("Should all muslims be killed?").harm, "hateful");
  assert.equal(classify("Is crypto good? Use code SAVE20 at checkout").harm, "spam");
  assert.equal(classify("Is my product the best? DM me for prices").harm, "spam");
  const target = classify("Does the guy at 12 Elm Street cheat on his wife?");
  assert.equal(target.harm, "private_person");
  assert.ok(target.results.every((r) => r.span && r.fix === ""));
  // A personal detail with no accusation is an ordinary fix.
  assert.equal(classify("Did 617 555 0100 call you last night?").harm, null);
  assert.ok(classify("Did 617 555 0100 call you last night?").results.length);
  // Every harmful result still says why and where.
  for (const r of classify("Are immigrants vermin?").results) assert.ok(r.reason && r.span && r.key.startsWith("hateful"));
});

test("questions that only need a look are held, not denied", async () => {
  const sweeping = await sweep("Are immigrants more dangerous than citizens?");
  assert.equal(sweeping.decision, "hold");
  const named = await sweep("Is Brenda Kowalczyk a liar?");
  assert.equal(named.decision, "hold");
  assert.match(named.hold ?? "", /Brenda Kowalczyk/);
  const degraded = await sweep("Is Brenda Kowalczyk a slut?");
  assert.equal(degraded.decision, "deny");
  assert.equal(degraded.harm, "harassing");
  assert.equal((await sweep("Is cereal better than toast?")).decision, "allow");
  // A refused question that just needs rewording offers the whole fixed question.
  const reworded = await sweep("Is my landlord allowed to keep the deposit?");
  assert.equal(reworded.decision, "deny");
  assert.equal(reworded.suggestion, "Is a landlord allowed to keep the deposit?");
});

test("grammar is off by default, never blocks, and keeps the CheckResult shape", async () => {
  const saved = process.env.LANGUAGETOOL_URL;
  delete process.env.LANGUAGETOOL_URL;
  try {
    assert.equal(grammarEnabled(), false);
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    assert.deepEqual(await grammarCheck("Is they going home?", { fetchImpl }), []);
    assert.equal(called, false);
    assert.deepEqual(await checkQuestionWithGrammar("Is they going home?"), checkQuestion("Is they going home?"));

    // With a server, its findings arrive as suggestions with why, where and a fix.
    const server = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.match(String(url), /^http:\/\/lt\.local\/v2\/check$/);
      assert.match(String(init?.body), /language=en-US/);
      return Response.json({
        matches: [{ message: "The verb doesn't agree with the subject.", shortMessage: "Agreement", offset: 0, length: 2, replacements: [{ value: "Are" }] }],
      });
    }) as typeof fetch;
    const checked = await checkQuestionWithGrammar("Is they going home?", { url: "http://lt.local", fetchImpl: server });
    const g = checked.results.find((r) => r.code === "grammar")!;
    assert.equal(g.blocking, false);
    assert.deepEqual(g.span, { start: 0, end: 2 });
    assert.equal(g.fix, "Are");
    assert.equal(g.key, "grammar_fix");
    assert.equal(checked.blocked, false);
    assert.equal(checked.suggestion, "Are they going home?");

    // A broken or slow server returns nothing rather than blocking.
    const broken = (async () => { throw new Error("down"); }) as typeof fetch;
    assert.deepEqual(await grammarCheck("Is they going home?", { url: "http://lt.local", fetchImpl: broken }), []);
  } finally {
    if (saved !== undefined) process.env.LANGUAGETOOL_URL = saved;
  }
});
