// S1, sanctions screening, against DATABASE_URL: the list parsers on small fixtures in the
// published formats (and their loud failures), name normalisation, imports and which import is
// current, screening hits and misses, refused countries, rescreening an approved party, the stale
// guard on approvals, the moderator's decisions, and the OFAC recent-actions check. Fixtures use
// fictional names.
//
// The database tests replace the current import of every list, so they only run on a database
// with no sanctions imports or OFAC actions of its own (a test or CI database); elsewhere they
// are skipped.
// Everything they create is removed afterwards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pool, query } from "../lib/db";
import { handlerFor, registerDefaultHandlers } from "../lib/jobs";
import { OFAC_ACTIONS_JOB, runOfacActionsCheck, runSanctionsRefresh, SANCTIONS_REFRESH_JOB } from "../lib/jobs/sanctions-handlers";
import { countryKey, normalizeName, toCountryCode } from "../lib/sanctions/normalize";
import {
  checkRecentActions, isCountryProgram, markActionReviewed, OFAC_RECENT_ACTIONS_URL, parseRecentActions, unreviewedCountryActions,
} from "../lib/sanctions/ofac-actions";
import {
  ofacPrograms, parseCsv, parseEu, parseList, parseOfac, parseUk, parseUn, SANCTIONS_LISTS, SANCTIONS_SOURCES,
  SanctionsFormatError, type SanctionsList,
} from "../lib/sanctions/parsers";
import {
  addParty, approveParty, assertScreeningFresh, getParty, importList, listFreshness, partiesToReview, refreshLists,
  refuseParty, rescreenAll, resolveHit, screenParty, screeningIsStale, ScreeningStale, type Fetcher,
} from "../lib/sanctions/screening";

const FIXTURES = path.join(__dirname, "fixtures", "sanctions");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const FILES: Record<SanctionsList, Record<string, string>> = {
  ofac_sdn: { primary: fixture("sdn.csv"), alt: fixture("alt.csv") },
  ofac_cons: { primary: fixture("cons_prim.csv"), alt: fixture("cons_alt.csv") },
  un: { main: fixture("un_consolidated.xml") },
  eu: { main: fixture("eu_full.csv") },
  uk: { main: fixture("uk_conlist.csv") },
};

// Serves the fixtures at the official addresses; `override` replaces or breaks a file.
function fixtureFetcher(override: Record<string, string | Error> = {}): Fetcher {
  const byUrl = new Map<string, string>();
  for (const list of SANCTIONS_LISTS) {
    for (const [key, url] of Object.entries(SANCTIONS_SOURCES[list].files)) byUrl.set(url, FILES[list][key]);
  }
  byUrl.set(OFAC_RECENT_ACTIONS_URL, fixture("ofac_recent_actions.html"));
  return async (url) => {
    const o = override[url];
    if (o instanceof Error) throw o;
    if (typeof o === "string") return o;
    const text = byUrl.get(url);
    if (text === undefined) throw new Error(`no fixture for ${url}`);
    return text;
  };
}

const tag = `s1${Date.now().toString(36)}`;
const partyIds: number[] = [];
let reviewer = 0;
let dbOk = false;
let partiesBefore = 0;

before(async () => {
  const [{ n }] = await query<{ n: number }>(
    "select (select count(*) from sanctions_list_imports) + (select count(*) from ofac_recent_actions) as n",
  );
  dbOk = Number(n) === 0;
  if (!dbOk) return;
  // Parties are removed by id range too, so one left by a failing call is cleaned up as well.
  const [max] = await query<{ id: string | null }>("select max(id) as id from screened_parties");
  partiesBefore = Number(max.id ?? 0);
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at, tier, role, origin)
     values ($1, $1, 'x', now(), 'free', 'moderator', 'test') returning id`,
    [`${tag}_mod`],
  );
  reviewer = row.id;
});

after(async () => {
  if (dbOk) {
    await query("delete from screened_parties where id = any($1::bigint[]) or id > $2", [partyIds, partiesBefore]);
    await query("delete from sanctions_list_imports");
    await query("delete from ofac_recent_actions");
    await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  }
  await pool.end();
});

const dbTest = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!dbOk) return t.skip("this database already holds sanctions imports");
    await fn();
  });

async function party(name: string, country: string | null, kind: "buyer" | "org" | "org_member" = "buyer") {
  const p = await addParty({ kind, name, country });
  partyIds.push(p.id);
  return p;
}

const openHits = async (partyId: number) =>
  query<{ id: number; list: string; matched_name: string; score: number }>(
    "select id::int, list, matched_name, score from screening_hits where party_id = $1 and resolution = 'open' order by score desc",
    [partyId],
  );

async function importAll() {
  for (const list of SANCTIONS_LISTS) {
    const r = await importList(list, FILES[list]);
    assert.ok(r.ok, r.ok ? "" : r.error);
  }
}

// ---------- Normalisation ----------

test("names are normalised: accents, case, punctuation, spaces and company forms", () => {
  assert.equal(normalizeName("  Société Générale, S.A. "), "societe generale");
  assert.equal(normalizeName("OOO Romashka-Treyd"), "romashka treyd");
  assert.equal(normalizeName("NORTHWIND HARBOR TRADING, L.L.C."), "northwind harbor trading");
  assert.equal(normalizeName("Müller & Söhne GmbH"), "muller sohne");
  assert.equal(normalizeName("O'Brien   Holdings Ltd."), "obrien holdings");
  assert.equal(normalizeName("Straße Łódź Ørsted"), "strasse lodz orsted");
  assert.equal(normalizeName("PJSC Alfa-Bank"), "alfa bank");
  assert.equal(normalizeName("ОАО «Минская оптика»"), "оао минская оптика"); // Cyrillic stays Cyrillic
  assert.equal(normalizeName("Limited Company"), "limited company"); // never normalised to nothing
  assert.equal(normalizeName(""), "");
  assert.equal(normalizeName(null), "");
});

test("country names map to ISO codes; unknown ones are kept as written", () => {
  assert.equal(toCountryCode("Russian Federation"), "RU");
  assert.equal(toCountryCode("Iran (Islamic Republic of)"), "IR");
  assert.equal(toCountryCode("Democratic People's Republic of Korea"), "KP");
  assert.equal(toCountryCode("Yemen"), "YE"); // not the retired YD
  assert.equal(toCountryCode("de"), "DE");
  assert.equal(toCountryCode("Atlantis"), null);
  assert.equal(countryKey("Atlantis"), "ATLANTIS");
});

// ---------- Parsers ----------

test("the CSV reader handles quotes, doubled quotes, line breaks in fields, CRLF, a BOM and semicolons", () => {
  assert.deepEqual(parseCsv('﻿a,"b, c","say ""hi"""\r\n1,"two\nlines",3\r\n\r\n'), [
    ["a", "b, c", 'say "hi"'],
    ["1", "two\nlines", "3"],
  ]);
  assert.deepEqual(parseCsv('x;"y;z";\n', ";"), [["x", "y;z", ""]]);
});

test("OFAC programs are split however their brackets are left", () => {
  assert.deepEqual(ofacPrograms("SDGT] [IRGC] [IFSR"), ["SDGT", "IRGC", "IFSR"]);
  assert.deepEqual(ofacPrograms("[UKRAINE-EO13662] [RUSSIA-EO14024]"), ["UKRAINE-EO13662", "RUSSIA-EO14024"]);
  assert.deepEqual(ofacPrograms("CUBA"), ["CUBA"]);
  assert.deepEqual(ofacPrograms("-0- "), []);
});

test("the OFAC SDN and Consolidated CSVs parse into names and aliases", () => {
  const sdn = parseOfac("ofac_sdn", FILES.ofac_sdn.primary, FILES.ofac_sdn.alt);
  assert.equal(sdn.filter((e) => !e.isAlias).length, 5);
  assert.equal(sdn.filter((e) => e.isAlias).length, 4);
  const harbor = sdn.find((e) => e.sourceId === "9102" && !e.isAlias)!;
  assert.equal(harbor.name, "NORTHWIND HARBOR TRADING, LLC"); // quoted comma kept
  assert.equal(harbor.kind, "entity"); // "-0-" type
  assert.deepEqual(harbor.programs, ["SDGT", "IRGC", "IFSR"]);
  assert.equal(sdn.find((e) => e.sourceId === "9103")!.kind, "vessel");
  assert.deepEqual(sdn.find((e) => e.sourceId === "9101" && !e.isAlias)!.countries, ["RU"]); // from the remarks
  const alias = sdn.find((e) => e.sourceId === "9104" && e.isAlias)!;
  assert.equal(alias.nameNorm, "romashka trade");
  assert.deepEqual(alias.programs, ["UKRAINE-EO13662", "RUSSIA-EO14024"]); // inherited from the primary
  const cons = parseList("ofac_cons", FILES.ofac_cons);
  assert.equal(cons.length, 3);
});

test("the UN consolidated XML parses individuals, entities, aliases and nationalities", () => {
  const un = parseUn(FILES.un.main);
  const khalid = un.filter((e) => e.sourceId === "6900001");
  assert.deepEqual(khalid.map((e) => e.name), ["KHALID ABDULLAH AL-FICTIONI", "Abu Khalid al-Fictioni"]); // empty alias skipped
  assert.deepEqual(khalid[0].countries, ["YE"]);
  assert.deepEqual(un.find((e) => e.sourceId === "6900002")!.countries, ["KP"]); // &apos; decoded
  const lotus = un.filter((e) => e.sourceId === "6910001");
  assert.equal(lotus[0].kind, "entity");
  assert.equal(lotus[1].name, "Kumryon & Partners");
});

test("the EU CSV groups rows by entity, whichever subject-type column it has", () => {
  const eu = parseEu(FILES.eu.main);
  const arkady = eu.filter((e) => e.sourceId === "880001");
  assert.deepEqual(arkady.map((e) => [e.name, e.isAlias]), [["Arkady Sergeyevich Volkonsky", false], ["Arkadiy Volkonskiy", true]]);
  assert.equal(arkady[0].kind, "person");
  assert.deepEqual(arkady[0].countries, ["RU"]);
  assert.equal(eu.find((e) => e.sourceId === "880002")!.kind, "entity");
  // The older file names the programme column Entity_Programme and has only Entity_SubjectType.
  const older = FILES.eu.main
    .replace("Entity_Regulation_Programme", "Entity_Programme")
    .replace("Entity_SubjectType;Entity_SubjectType_ClassificationCode", "Entity_SubjectType;Ignored_Column");
  assert.equal(parseEu(older).filter((e) => e.kind === "person").length, 3);
});

test("the UK OFSI CSV finds its header, builds full names and groups aliases", () => {
  const uk = parseUk(FILES.uk.main);
  const kostenko = uk.filter((e) => e.sourceId === "77001");
  assert.deepEqual(kostenko.map((e) => [e.name, e.isAlias]), [["Dmitri Ivanovich KOSTENKO", false], ["Dmitry KOSTENKO", true]]);
  assert.deepEqual(kostenko[0].countries, ["RU", "CY"]);
  assert.equal(uk.find((e) => e.sourceId === "77002" && e.isAlias)!.name, "STEP EAGL MAINING");
  assert.equal(uk.find((e) => e.sourceId === "77003")!.kind, "vessel");
});

test("parsers fail loudly on a missing column, a wrong shape or an empty file", () => {
  assert.throws(() => parseEu(FILES.eu.main.replace("NameAlias_WholeName", "NameAlias_Whole")), /eu: missing column NameAlias_WholeName/);
  assert.throws(() => parseEu(FILES.eu.main.replace("Entity_LogicalId", "Entity_Id")), SanctionsFormatError);
  assert.throws(() => parseUk(FILES.uk.main.replace(",Group ID", ",Group")), /uk: missing column Group ID/);
  assert.throws(() => parseUk("Last Updated,1/1/2026\nfoo,bar\n"), /uk: missing column Name 6/);
  assert.throws(() => parseUn("<OTHER_LIST></OTHER_LIST>"), /un: no CONSOLIDATED_LIST/);
  assert.throws(() => parseUn("<CONSOLIDATED_LIST><INDIVIDUALS/><ENTITIES/></CONSOLIDATED_LIST>"), /un: the file has no entries/);
  assert.throws(() => parseOfac("ofac_sdn", '1,"NAME","individual"\n', ""), /expected 12/);
  assert.throws(() => parseOfac("ofac_sdn", "\x1a\n", ""), /ofac_sdn: the file has no entries/);
  assert.throws(() => parseList("ofac_sdn", { primary: FILES.ofac_sdn.primary }), /missing file "alt"/);
});

// ---------- Imports ----------

dbTest("an import becomes current, the next replaces it, and a failed one keeps the previous", async () => {
  assert.equal(await screeningIsStale(), true); // nothing loaded yet
  const first = await importList("uk", FILES.uk);
  assert.ok(first.ok);
  const second = await importList("uk", FILES.uk);
  assert.ok(second.ok);
  const rows = await query<{ id: number; is_current: boolean; entry_count: number }>(
    "select id::int, is_current, entry_count from sanctions_list_imports where list = 'uk' order by id",
  );
  assert.deepEqual(rows.map((r) => r.is_current), [false, true]);
  assert.equal(rows[1].entry_count, 5);
  // Only the current import's names remain.
  const [{ n }] = await query<{ n: number }>("select count(*)::int as n from sanctions_entries where list = 'uk'");
  assert.equal(n, 5);

  const failed = await importList("uk", { main: FILES.uk.main.replace(",Group ID", ",Group") });
  assert.equal(failed.ok, false);
  const [current] = await query<{ id: number }>("select id::int from sanctions_list_imports where list = 'uk' and is_current");
  assert.equal(current.id, second.importId);
  const [bad] = await query<{ status: string; error: string; is_current: boolean }>(
    "select status, error, is_current from sanctions_list_imports where id = $1", [failed.importId],
  );
  assert.equal(bad.status, "failed");
  assert.equal(bad.is_current, false);
  assert.match(bad.error, /missing column Group ID/);
  const uk = (await listFreshness()).find((l) => l.list === "uk")!;
  assert.equal(uk.entryCount, 5);
  assert.match(uk.lastError ?? "", /Group ID/);
});

dbTest("a refresh imports every list; one failing list doesn't stop the others", async () => {
  const broken = fixtureFetcher({ [SANCTIONS_SOURCES.eu.files.main]: new Error("connection reset") });
  const { results } = await refreshLists(broken);
  assert.deepEqual(results.map((r) => [r.list, r.ok]), [["ofac_sdn", true], ["ofac_cons", true], ["un", true], ["eu", false], ["uk", true]]);
  const eu = results.find((r) => r.list === "eu")!;
  assert.match(eu.ok ? "" : eu.error, /download failed: connection reset/);
  assert.equal(await screeningIsStale(), true); // EU never loaded
  await assert.rejects(assertScreeningFresh(), ScreeningStale);
  const again = await refreshLists(fixtureFetcher());
  assert.ok(again.results.every((r) => r.ok));
  assert.equal(await screeningIsStale(), false);
});

// ---------- Screening ----------

dbTest("a listed name, spelt differently or in another order, is a hit and waits for review", async () => {
  await importAll();
  const p = await party(`Ivan Petrovich Zarkov`, "DE");
  assert.equal(p.status, "review");
  const hits = await openHits(p.id);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].list, "ofac_sdn");
  assert.equal(hits[0].score, 1); // same words, other order

  const spelt = await party("Northwind Harbour Trading Co", "AE", "org");
  assert.equal(spelt.status, "review");
  assert.ok((await openHits(spelt.id)).some((h) => h.list === "ofac_sdn"));

  // A name inside a longer listed name.
  const inside = await party("Steppe Eagle", "KZ", "org");
  assert.equal(inside.status, "review");
  assert.ok((await openHits(inside.id)).some((h) => h.list === "uk"));

  // A shared country raises the score, never the other way.
  const near = await party("Dmitri Kostenko", "CY");
  const far = await party("Dmitri Kostenko", "PT");
  const [nearTop] = await openHits(near.id);
  const [farTop] = await openHits(far.id);
  assert.ok(nearTop.score > farTop.score, `${nearTop.score} > ${farTop.score}`);
  assert.equal(far.status, "review");
});

dbTest("a name on no list is clear, which still isn't approved", async () => {
  await importAll();
  const p = await party(`Juniper Fieldwork Analytics ${tag}`, "US", "org");
  assert.equal(p.status, "clear");
  assert.equal((await openHits(p.id)).length, 0);
  assert.ok(p.last_screened_at);
  assert.equal(p.reviewed_by, null);
});

dbTest("parties based in blocked or no-buyer countries are refused, naming the country", async () => {
  await importAll();
  for (const [country, name] of [["CN", "China"], ["RU", "Russia"], ["VE", "Venezuela"], ["IR", "Iran"], ["HK", "Hong Kong"]]) {
    const p = await party(`Clear Water Research ${tag} ${country}`, country, "org");
    assert.equal(p.status, "refused", country);
    assert.match(p.status_reason ?? "", new RegExp(`${name}.*\\(${country}\\)`));
    assert.equal(await approveParty(p.id, reviewer), "no_buyer_country");
  }
  const none = await party(`No Country Research ${tag}`, null, "org");
  assert.equal(none.status, "refused");
  assert.match(none.status_reason ?? "", /no stated country/);
});

dbTest("an approved party with a new hit goes back to review, and rescreens don't duplicate hits", async () => {
  await importAll();
  const p = await party("Harbor Light Logistics", "NL", "org");
  assert.equal(p.status, "clear");
  assert.equal(await approveParty(p.id, reviewer), null);
  assert.equal((await getParty(p.id))!.status, "approved");
  await rescreenAll();
  assert.equal((await getParty(p.id))!.status, "approved"); // still no hit

  // The UK list adds the name; the next refresh rescreens.
  const header = parseCsv(FILES.uk.main)[1];
  const values: Record<string, string> = {
    "Name 6": "HARBOR LIGHT LOGISTICS B.V.", Country: "Netherlands", "Group Type": "Entity", "Alias Type": "Primary name",
    Regime: "Russia", "Group ID": "77009",
  };
  const newRow = header.map((h) => `"${values[h] ?? ""}"`).join(",");
  const ukMore = FILES.uk.main.trimEnd() + "\r\n" + newRow + "\r\n";
  const { results } = await refreshLists(fixtureFetcher({ [SANCTIONS_SOURCES.uk.files.main]: ukMore }));
  assert.ok(results.every((r) => r.ok));
  const after = (await getParty(p.id))!;
  assert.equal(after.status, "review");
  const hits = await openHits(p.id);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].score >= 1, "same country adds to an exact match, capped at 1");
  assert.equal(await approveParty(p.id, reviewer), "open_hits");

  await rescreenAll();
  await screenParty(p.id);
  assert.equal((await openHits(p.id)).length, 1); // no duplicate
});

dbTest("approvals are refused while any list is stale", async () => {
  await importAll();
  const p = await party(`Quiet Meadow Surveys ${tag}`, "CA", "org");
  assert.equal(p.status, "clear");
  await query("update sanctions_list_imports set fetched_at = now() - interval '49 hours' where list = 'un' and is_current");
  assert.equal(await screeningIsStale(), true);
  assert.ok((await listFreshness()).find((l) => l.list === "un")!.stale);
  await assert.rejects(approveParty(p.id, reviewer), ScreeningStale);
  assert.equal((await getParty(p.id))!.status, "clear");
  await importList("un", FILES.un);
  assert.equal(await screeningIsStale(), false);
  assert.equal(await approveParty(p.id, reviewer), null);
});

dbTest("a moderator resolves hits: a false match leaves the party to approve, a true match refuses it", async () => {
  await importAll();
  const p = await party("Arkadiy Volkonsky", "FR");
  assert.equal(p.status, "review");
  const [hit] = await openHits(p.id);
  assert.equal(await resolveHit(hit.id, reviewer, "false_match", "Different date of birth"), null);
  assert.equal(await resolveHit(hit.id, reviewer, "true_match", ""), "decided");
  const cleared = (await getParty(p.id))!;
  assert.equal(cleared.status, "clear");
  assert.equal(cleared.reviewed_by, null); // not approved by the false match
  // A rescreen doesn't reopen a hit a person marked as a false match.
  await screenParty(p.id);
  assert.equal((await openHits(p.id)).length, 0);
  assert.equal(await approveParty(p.id, reviewer), null);
  const approved = (await getParty(p.id))!;
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewed_by, reviewer);

  const q = await party("Khalid Abdullah al-Fictioni", "GB");
  const [qHit] = await openHits(q.id);
  assert.ok((await partiesToReview()).some((r) => r.id === q.id && r.hits.some((h) => h.id === qHit.id)));
  assert.equal(await resolveHit(qHit.id, reviewer, "true_match", "Same passport"), null);
  const refused = (await getParty(q.id))!;
  assert.equal(refused.status, "refused");
  assert.match(refused.status_reason ?? "", /Confirmed match on the UN/);
  assert.equal(await approveParty(q.id, reviewer), "refused");
  await screenParty(q.id); // a person's refusal stands
  assert.equal((await getParty(q.id))!.status, "refused");

  const r = await party(`Lantern Bay Partners ${tag}`, "IE", "org");
  assert.equal(await refuseParty(r.id, reviewer, "  "), "reason");
  assert.equal(await refuseParty(r.id, reviewer, "Would not say who owns it"), null);
  assert.equal((await getParty(r.id))!.status, "refused");
  assert.equal(await resolveHit(999_999_999, reviewer, "false_match", ""), "not_found");
});

// ---------- OFAC recent actions ----------

test("the OFAC recent actions page parses into dated actions with links", () => {
  const actions = parseRecentActions(fixture("ofac_recent_actions.html"));
  assert.equal(actions.length, 7); // nav and pager links skipped
  assert.deepEqual(actions[0], {
    date: "2026-11-14",
    title: "Russia-related Designations; Counter Terrorism Designation Removal",
    url: "https://ofac.treasury.gov/recent-actions/20261114",
  });
  assert.equal(actions[1].url, "https://ofac.treasury.gov/recent-actions/20261114_1");
  assert.equal(actions[5].title, "Cyber-related Designations & Designation Update");
  // No date in the link: the date written before it.
  assert.deepEqual(actions[6], {
    date: "2026-11-05", title: "Issuance of Syria-related Frequently Asked Question",
    url: "https://ofac.treasury.gov/recent-actions/syria-faq-update",
  });
  assert.throws(() => parseRecentActions("<html><body>Maintenance</body></html>"), /no actions found/);
});

test("actions touching a watched place, or a programme word with any country, are flagged", () => {
  assert.equal(isCountryProgram("Russia-related Designations"), true);
  assert.equal(isCountryProgram("Iranian Oil Network Designations"), true);
  assert.equal(isCountryProgram("Issuance of Amended Venezuela-related General License"), true);
  assert.equal(isCountryProgram("Crimea-related Designation Update"), true);
  assert.equal(isCountryProgram("Publication of Burma Sanctions Regulations"), true);
  assert.equal(isCountryProgram("New Executive Order on Nicaragua"), true);
  assert.equal(isCountryProgram("Nicaragua-related Designations"), false); // a country, no programme word
  assert.equal(isCountryProgram("Counter Terrorism Designations"), false);
  assert.equal(isCountryProgram("Publication of Updated Sanctions List Service Program Guide"), false); // no country
});

dbTest("the recent actions check records new actions once and flags country programmes", async () => {
  const first = await checkRecentActions(fixtureFetcher());
  assert.deepEqual(first, { found: 7, inserted: 7, flagged: 5 });
  const again = await checkRecentActions(fixtureFetcher());
  assert.deepEqual(again, { found: 7, inserted: 0, flagged: 0 });
  const flagged = await unreviewedCountryActions();
  assert.equal(flagged.length, 5);
  assert.ok(!flagged.some((a) => a.title.startsWith("Counter Terrorism")));
  assert.equal(await markActionReviewed(flagged[0].id, reviewer), true);
  assert.equal(await markActionReviewed(flagged[0].id, reviewer), false);
  assert.equal((await unreviewedCountryActions()).length, 4);
});

// ---------- Jobs ----------

test("both sanctions jobs are registered to run daily", () => {
  registerDefaultHandlers();
  assert.equal(handlerFor(SANCTIONS_REFRESH_JOB)?.everySeconds, 24 * 3600);
  assert.equal(handlerFor(OFAC_ACTIONS_JOB)?.everySeconds, 24 * 3600);
});

dbTest("a second run started while one is running does nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixtures = fixtureFetcher();
  const slow: Fetcher = async (url) => {
    await gate;
    return fixtures(url);
  };
  const first = runSanctionsRefresh(slow);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await runSanctionsRefresh(fixtures), null);
  release();
  const done = await first;
  assert.ok(done && done.results.every((r) => r.ok));
  assert.ok(await runOfacActionsCheck(fixtures));
});
