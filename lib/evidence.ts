import type { PoolClient } from "pg";
import { query } from "./db";
import { assertNoSeedData } from "./provenance";
import { minGroupSize, SALE_ELIGIBLE_ACCOUNTS } from "./regions";
import type { VoteValue } from "./votes";

// Vote evidence: the who, what, when, where and how of each vote action, kept as small as it can
// be while still answering a buyer's question. See db/migrations/20261125_0100_e1_vote_evidence.sql.
//
// Most of it already lives on vote_events (the account number, the action and answer, the exact
// time, the surface and the time to decide). The vote path adds one row to vote_evidence for the
// rest, and only on questions wired in vote_evidence_questions:
//   * the person's own chosen attributes at that moment (age range, home country);
//   * a coarse region the phone worked out itself, when it sent one;
//   * the interface family;
//   * the answer before this one, how many changes so far, and how long the last one was held.
//
// A buyer never sees a row of it. evidenceTotals() is the only way out: day-level totals for one
// question, from real people who opted in to sale, with any group smaller than the region's
// minimum left out.

export const INTERFACES = ["web", "app", "ai_head", "integration"] as const;
export type Interface = (typeof INTERFACES)[number];

// Surfaces a person reaches through our own pages count as web. Everything else in SURFACES
// (Slack, Discord, texts, email and the rest) is an integration. The phone app and the AI head
// say so themselves when they arrive; neither exists yet.
const WEB_SURFACES = new Set(["web", "share", "embed", "qr", "extension"]);

export function interfaceFor(surface: string | null | undefined, explicit?: unknown): Interface {
  if (typeof explicit === "string" && (INTERFACES as readonly string[]).includes(explicit)) return explicit as Interface;
  return WEB_SURFACES.has(surface ?? "web") ? "web" : "integration";
}

// An ISO 3166-2 code such as "US-MA" or "GB-SCT", as the phone reports it. Anything else,
// including coordinates or a free-text place, is dropped rather than stored.
export function cleanDeviceRegion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(v) ? v : null;
}

export type EvidenceInput = {
  eventId: string | number;
  eventCreatedAt: string;          // as Postgres text, so the microseconds survive the round trip
  accountId: number;
  region: string | null;
  interface: Interface;
  previousValue: VoteValue | null;
  changeNumber: number;
  previousAt: Date | null;
  at: Date;
};

// Written inside the vote's own transaction, so the evidence and the vote stand or fall together.
// The attributes are read from account_demographics in the same statement, as they are now.
export async function recordEvidence(client: PoolClient, e: EvidenceInput): Promise<void> {
  const held = e.previousAt ? Math.floor((e.at.getTime() - e.previousAt.getTime()) / 1000) : null;
  await client.query(
    `insert into vote_evidence (event_id, event_created_at, age_range, home_country, region, interface,
                                previous_value, change_number, seconds_since_previous)
     select $1::bigint, $2::timestamptz, d.age_range, d.country, $4::text, $5::text, $6::text, $7::int, $8::int
       from (values (1)) one
       left join account_demographics d on d.account_id = $3::int`,
    [e.eventId, e.eventCreatedAt, e.accountId, e.region, e.interface, e.previousValue, e.changeNumber,
     held !== null && held >= 0 ? held : null],
  );
}

// ---------- Which questions are wired ----------

export async function wireQuestion(questionId: number, note: string | null = null): Promise<void> {
  await query(
    "insert into vote_evidence_questions (question_id, note) values ($1, $2) on conflict (question_id) do update set note = excluded.note",
    [questionId, note],
  );
}

export async function unwireQuestion(questionId: number): Promise<void> {
  await query("delete from vote_evidence_questions where question_id = $1", [questionId]);
}

export async function wiredQuestions(): Promise<number[]> {
  const rows = await query<{ question_id: number }>("select question_id from vote_evidence_questions order by question_id");
  return rows.map((r) => r.question_id);
}

// ---------- What a buyer may see ----------

export type EvidenceTotal = {
  day: string;                     // UTC day, YYYY-MM-DD; never a time
  action: "cast" | "change" | "delete" | "skip";
  value: VoteValue | null;
  previousValue: VoteValue | null;
  ageRange: string | null;
  homeCountry: string | null;
  region: string | null;
  interface: Interface;
  people: number;
  medianDecideMs: number | null;
  averageChanges: number;
  medianHeldSeconds: number | null;
};

// Day-level totals for one question. Only real people's public answers, only from accounts that
// may be included in a sale (SALE_ELIGIBLE_ACCOUNTS: agreed to answering, opted in to sale
// without GPC, in a region open to sale), and only groups of at least the minimum size. Refuses
// while any seed data is left, like the person-level sale export.
export async function evidenceTotals(questionId: number): Promise<EvidenceTotal[]> {
  await assertNoSeedData();
  const min = await minGroupSize();
  const rows = await query<{
    day: string; action: EvidenceTotal["action"]; value: VoteValue | null; previous_value: VoteValue | null;
    age_range: string | null; home_country: string | null; region: string | null; interface: Interface;
    people: number; median_decide_ms: number | null; average_changes: string; median_held_seconds: number | null;
  }>(
    `select to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD') as day, e.action, e.value, ve.previous_value,
            ve.age_range, ve.home_country, ve.region, ve.interface,
            count(distinct e.account_id)::int as people,
            (percentile_cont(0.5) within group (order by e.answer_ms))::int as median_decide_ms,
            round(avg(ve.change_number), 2)::text as average_changes,
            (percentile_cont(0.5) within group (order by ve.seconds_since_previous))::int as median_held_seconds
       from vote_events e
       join vote_evidence ve on ve.event_id = e.id and ve.event_created_at = e.created_at
      where e.question_id = $1
        and e.origin = 'real'
        and not e.is_private
        and e.account_id in (${SALE_ELIGIBLE_ACCOUNTS})
      group by 1, 2, 3, 4, 5, 6, 7, 8
     having count(distinct e.account_id) >= $2
      order by 1, 2, 3, 4, 5, 6, 7, 8`,
    [questionId, min],
  );
  return rows.map((r) => ({
    day: r.day, action: r.action, value: r.value, previousValue: r.previous_value, ageRange: r.age_range,
    homeCountry: r.home_country, region: r.region, interface: r.interface, people: r.people,
    medianDecideMs: r.median_decide_ms, averageChanges: Number(r.average_changes), medianHeldSeconds: r.median_held_seconds,
  }));
}
