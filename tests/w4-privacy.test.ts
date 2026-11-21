// W4 privacy tests: optional details and children (never a name or birth date), the export and
// deletion covering consent and demographics, and small slices hidden from breakdowns.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool, query } from "../lib/db";
import type { Account } from "../lib/auth";
import { deleteAccount, exportData } from "../lib/account";
import { currentText, hideAllIfAnySmall, hideSmallSlices, recordConsent } from "../lib/consent";
import {
  addChild, clearAllDemographics, clearDemographic, getDemographics, listChildren, removeChild, setDemographics,
} from "../lib/demographics";
import { minGroupSize, regionFor } from "../lib/regions";

const tag = `w4p${Date.now().toString(36)}`;
let n = 0;

async function makeAccount(): Promise<Account> {
  const name = `${tag}_${n++}`;
  const [row] = await query<{ id: number }>(
    `insert into accounts (username, phone_hash, password_hash, consented_at) values ($1, $1, 'x', now()) returning id`,
    [name],
  );
  return { id: row.id, username: name, tier: "free", verified: false, role: "user" };
}

after(async () => {
  await query("delete from accounts where username like $1", [`${tag}\\_%`]);
  await pool.end();
});

test("children: only son/daughter/child and an age range; names and birth dates are refused", async () => {
  const me = await makeAccount();
  assert.deepEqual(await addChild(me.id, { relation: "son", ageRange: "6-9" }), { ok: false, error: "not_parent" });
  assert.deepEqual(await setDemographics(me.id, { isParent: true }), { ok: true });

  assert.deepEqual(await addChild(me.id, { relation: "son", ageRange: "6-9", name: "Sam" }), { ok: false, error: "unknown_field" });
  assert.deepEqual(await addChild(me.id, { relation: "daughter", ageRange: "3-5", birthDate: "2022-01-01" }), { ok: false, error: "unknown_field" });
  assert.deepEqual(await addChild(me.id, { relation: "daughter", ageRange: "3-5", accountId: 12 }), { ok: false, error: "unknown_field" });
  assert.deepEqual(await addChild(me.id, { relation: "nephew", ageRange: "3-5" }), { ok: false, error: "relation" });
  assert.deepEqual(await addChild(me.id, { relation: "child", ageRange: "4" }), { ok: false, error: "child_age" });
  assert.equal((await listChildren(me.id)).length, 0, "nothing is stored from a refused child");

  assert.deepEqual(await addChild(me.id, { relation: "daughter", ageRange: "13-15" }), { ok: true });
  assert.deepEqual(await addChild(me.id, { relation: "child", ageRange: "0-2" }), { ok: true });
  const kids = await listChildren(me.id);
  assert.deepEqual(kids.map((c) => [c.relation, c.ageRange]), [["daughter", "13-15"], ["child", "0-2"]]);
  await removeChild(me.id, kids[0].id);
  assert.equal((await listChildren(me.id)).length, 1);

  // The table itself has nowhere to put a name, a birth date or an account.
  const columns = await query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'account_children' order by column_name",
  );
  assert.deepEqual(columns.map((c) => c.column_name), ["account_id", "age_range", "created_at", "id", "relation"]);
  await assert.rejects(query("insert into account_children (account_id, relation, age_range) values ($1, 'son', '2015-04-01')", [me.id]));

  // No longer a parent: what they said about children is cleared too.
  await clearDemographic(me.id, "isParent");
  assert.equal((await listChildren(me.id)).length, 0);
});

test("optional details are validated and each can be cleared", async () => {
  const me = await makeAccount();
  assert.deepEqual(await setDemographics(me.id, { ageRange: "12-17" }), { ok: false, error: "age_range" });
  assert.deepEqual(await setDemographics(me.id, { country: "Mexico" }), { ok: false, error: "country" });
  assert.deepEqual(await setDemographics(me.id, { ageRange: "35-44", country: "mx", isParent: true }), { ok: true });
  assert.deepEqual(await setDemographics(me.id, { name: "x" } as never), { ok: false, error: "unknown_field" });
  let about = await getDemographics(me.id);
  assert.deepEqual([about.ageRange, about.country, about.isParent], ["35-44", "MX", true]);
  await clearDemographic(me.id, "country");
  about = await getDemographics(me.id);
  assert.deepEqual([about.ageRange, about.country, about.isParent], ["35-44", null, true]);
  await clearAllDemographics(me.id);
  about = await getDemographics(me.id);
  assert.deepEqual([about.ageRange, about.country, about.isParent], [null, null, null]);
  const rows = await query("select 1 from account_demographics where account_id = $1", [me.id]);
  assert.equal(rows.length, 0, "clearing everything leaves no row");
});

test("the export includes consent records, details and children; deleting removes them", async () => {
  const me = await makeAccount();
  const text = await currentText("answering", "en");
  await recordConsent({ accountId: me.id, choice: "answering", granted: true, version: text!.version, lang: "en" },
    { gpc: false, region: "MX", surface: "share", lang: "en" });
  await setDemographics(me.id, { ageRange: "25-34", isParent: true });
  await addChild(me.id, { relation: "son", ageRange: "10-12" });

  const data = await exportData(me.id);
  assert.equal(data.consentRecords.length, 1);
  assert.deepEqual(
    { ...data.consentRecords[0], at: undefined },
    { choice: "answering", granted: true, textVersion: "2", lang: "en", surface: "share", region: "MX", globalPrivacyControl: false, at: undefined },
  );
  assert.equal(data.aboutYou.ageRange, "25-34");
  assert.equal(data.aboutYou.isParent, true);
  assert.deepEqual(data.aboutYou.children.map((c) => [c.relation, c.ageRange]), [["son", "10-12"]]);

  await deleteAccount(me.id);
  for (const table of ["consent_records", "account_demographics", "account_children"]) {
    const rows = await query(`select 1 from ${table} where account_id = $1`, [me.id]);
    assert.equal(rows.length, 0, table);
  }
  // The stand-in that keeps anonymous vote history has none of them either.
  const standIns = await query(
    `select 1 from accounts a where a.deleted_at is not null and a.deleted_at > now() - interval '1 minute'
        and exists (select 1 from consent_records r where r.account_id = a.id)`,
  );
  assert.equal(standIns.length, 0);
});

test("small slices are hidden, including ones a total would give back", () => {
  const size = (s: { n: number }) => s.n;
  const slices = [{ k: "a", n: 120 }, { k: "b", n: 60 }, { k: "c", n: 3 }];
  // c is too small; hiding it alone would leave it as total minus a minus b, so b goes too.
  assert.deepEqual(hideSmallSlices(slices, size, 50).map((s) => s.k), ["a"]);
  // Once what's hidden adds up to the minimum, the rest can show.
  assert.deepEqual(hideSmallSlices([{ k: "a", n: 120 }, { k: "b", n: 30 }, { k: "c", n: 25 }], size, 50).map((s) => s.k), ["a"]);
  assert.deepEqual(hideSmallSlices([{ k: "a", n: 120 }, { k: "b", n: 80 }, { k: "c", n: 0 }], size, 50).map((s) => s.k), ["a", "b"]);
  // With a merge, hidden slices come back as one "other" slice when it is big enough.
  const merged = hideSmallSlices(
    [{ k: "a", n: 200 }, { k: "b", n: 30 }, { k: "c", n: 25 }], size, 50, { merge: (total) => ({ k: "other", n: total }) },
  );
  assert.deepEqual(merged.map((s) => [s.k, s.n]), [["a", 200], ["other", 55]]);
  // Without a total anywhere, complementary hiding can be turned off.
  assert.deepEqual(hideSmallSlices(slices, size, 50, { complementary: false }).map((s) => s.k), ["a", "b"]);
  assert.deepEqual(hideSmallSlices([{ k: "a", n: 4 }], size, 5), []);

  const pub = { pct: 60 };
  const priv = { pct: 40 };
  assert.deepEqual(hideAllIfAnySmall({ public: pub, private: null }, { public: 80, private: 3 }, 50), { public: null, private: null });
  assert.deepEqual(hideAllIfAnySmall({ public: pub, private: null }, { public: 80, private: 0 }, 50), { public: pub, private: null });
  assert.deepEqual(hideAllIfAnySmall({ public: pub, private: priv }, { public: 80, private: 60 }, 50), { public: pub, private: priv });
});

test("the minimum group size comes from the region, 50 by default; MIN_GROUP_SIZE overrides it", async () => {
  const saved = process.env.MIN_GROUP_SIZE;
  try {
    process.env.MIN_GROUP_SIZE = "7";
    assert.equal(await minGroupSize(), 7);
    delete process.env.MIN_GROUP_SIZE;
    assert.equal((await regionFor(null)).code, "*");
    assert.equal((await regionFor("QZ")).code, "*", "a region without a row is '*'");
    assert.equal(await minGroupSize(null), 50);
    assert.ok((await minGroupSize()) >= 50);
  } finally {
    if (saved === undefined) delete process.env.MIN_GROUP_SIZE;
    else process.env.MIN_GROUP_SIZE = saved;
  }
});
