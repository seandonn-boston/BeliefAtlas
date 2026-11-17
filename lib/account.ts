import { randomBytes } from "crypto";
import { query, transaction } from "./db";
import { consentHistory } from "./consent/ledger";
import { getDemographics, listChildren } from "./demographics";

// ---------- Export ----------

// Everything the site holds about one account, in a form the owner can read.
export async function exportData(accountId: number) {
  const [account] = await query(
    `select username, created_at, consented_at, phone_verified_at, age_verified_at, age_method, phone_line_type, tier, subscription_status, role, last_active_at,
            region, lang
       from accounts where id = $1`,
    [accountId],
  );
  const [votes, history, asked, reports, consent, demographics, children] = await Promise.all([
    query(
      `select q.id as question_id, q.text as question, v.value, v.is_private, v.first_cast_at, v.updated_at
         from votes v join questions q on q.id = v.question_id where v.account_id = $1 order by v.first_cast_at`,
      [accountId],
    ),
    query(
      `select e.question_id, q.text as question, e.action, e.value, e.is_private, e.source, e.blind, e.created_at
         from vote_events e join questions q on q.id = e.question_id where e.account_id = $1 order by e.created_at, e.id`,
      [accountId],
    ),
    query("select id, text, status, created_at from questions where asked_by = $1 order by created_at", [accountId]),
    query(
      `select r.question_id, q.text as question, r.reason, r.note, r.created_at, r.resolution
         from reports r join questions q on q.id = r.question_id where r.account_id = $1 order by r.created_at`,
      [accountId],
    ),
    consentHistory(accountId),
    getDemographics(accountId),
    listChildren(accountId),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    note: "Your phone number is not included because the site never stores it, only a one-way hash of it.",
    account,
    currentVotes: votes,
    voteHistory: history,
    questionsAsked: asked,
    reportsFiled: reports,
    // Every consent choice ever recorded, oldest first, with the text version shown, the
    // surface and region it was made on, and whether Global Privacy Control was on.
    consentRecords: consent.reverse().map((r) => ({
      choice: r.choice, granted: r.granted, textVersion: r.textVersion, lang: r.lang, surface: r.surface,
      region: r.region, globalPrivacyControl: r.gpc, at: r.createdAt,
    })),
    aboutYou: {
      ageRange: demographics.ageRange,
      country: demographics.country,
      isParent: demographics.isParent,
      updatedAt: demographics.updatedAt,
      children: children.map((c) => ({ relation: c.relation, ageRange: c.ageRange, addedAt: c.createdAt })),
    },
  };
}

// ---------- Deletion ----------

// Deleting an account:
//   - withdraws every current vote, so it leaves all tallies from this moment on;
//   - keeps the dated history of past votes, moved to a new anonymous stand-in record with a
//     new id and no username, phone, password or payment details, so nothing links it back;
//   - keeps questions the person asked (they were always anonymous) and their reports, also
//     moved to the stand-in;
//   - removes the account, its sessions, skips and everything else tied to it, including its
//     consent records, the optional details about the person and anything they said about
//     their children.
export async function deleteAccount(accountId: number): Promise<void> {
  await transaction(async (client) => {
    const { rows } = await client.query<{ consented_at: Date; last_active_at: Date; origin: string }>(
      "select consented_at, last_active_at, origin from accounts where id = $1 and deleted_at is null for update",
      [accountId],
    );
    if (!rows[0]) return;

    await client.query(
      `insert into vote_events (account_id, question_id, action, value, is_private, source)
       select account_id, question_id, 'delete', null, is_private, 'direct' from votes where account_id = $1`,
      [accountId],
    );
    await client.query("delete from votes where account_id = $1", [accountId]);

    const stand = randomBytes(12).toString("hex");
    // The stand-in keeps the account's origin (real, test or seed), so the history it carries
    // keeps it too; the database refuses to move events between origins.
    const { rows: [standIn] } = await client.query<{ id: number }>(
      `insert into accounts (username, phone_hash, password_hash, consented_at, last_active_at, deleted_at, origin)
       values ($1, $2, '!', $3, $4, now(), $5) returning id`,
      [`deleted_${stand}`, `deleted:${stand}`, rows[0].consented_at, rows[0].last_active_at, rows[0].origin],
    );
    await client.query("update vote_events set account_id = $2 where account_id = $1", [accountId, standIn.id]);
    await client.query("update reports set account_id = $2 where account_id = $1", [accountId, standIn.id]);
    // Questions stay marked as asked by a person (not part of the catalog), via the stand-in.
    await client.query("update questions set asked_by = $2 where asked_by = $1", [accountId, standIn.id]);
    await client.query("delete from account_children where account_id = $1", [accountId]);
    await client.query("delete from account_demographics where account_id = $1", [accountId]);
    // consent_records go with the account row (on delete cascade). They are append-only, and
    // the database allows removing them only once the account row itself is gone.
    await client.query("delete from accounts where id = $1", [accountId]);
  });
}
