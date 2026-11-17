import { pool, transaction } from "../db";
import { logDecision, type Db } from "./log";
import type { HarmKind } from "./sweep";

// Demerits and bans. The owner's rules:
//   * Nobody is ever banned permanently for a question they asked. Harmful questions earn
//     demerits; enough active demerits bring a temporary ban from asking, and each ban is longer
//     than the last (BAN_LADDER_DAYS). Demerits expire, so the ladder resets with good behaviour.
//   * A permanent ban is only for vote manipulation, only after a moderator confirms a signal,
//     and only for the accounts that manipulated (./manipulation.ts). The bans table itself
//     refuses a permanent ban for any other cause.
//   * Ordinary denials (a question that just needs rewording) never add a demerit.
//   * A ban from asking still lets the person vote and browse.

export const BAN_LADDER_DAYS = [1, 7, 30, 90] as const;
// Active points at which a ban starts. The first harmful question is a warning.
export const BAN_AT_POINTS = Math.max(1, Number(process.env.DEMERIT_BAN_POINTS ?? 2));
export const DEMERIT_DAYS = Math.max(1, Number(process.env.DEMERIT_DAYS ?? 180));
// Earlier bans count toward the next step for this long.
export const BAN_MEMORY_DAYS = 365;

// The length of the next ban from asking, given how many demerit bans came before it.
export function banLengthDays(priorBans: number): number {
  return BAN_LADDER_DAYS[Math.min(Math.max(0, priorBans), BAN_LADDER_DAYS.length - 1)];
}

export type Ban = {
  id: number;
  scope: "asking" | "all";
  cause: "demerits" | "manipulation" | "other";
  permanent: boolean;
  reason: string;
  starts_at: Date;
  ends_at: Date | null;
};

// The ban in force that stops this account doing `what`, if any. Asking is stopped by any ban;
// voting only by a ban on everything (manipulation).
export async function activeBan(accountId: number, what: "asking" | "voting" = "asking", db: Db = pool): Promise<Ban | null> {
  const { rows } = await db.query<Ban>(
    `select id::int, scope, cause, permanent, reason, starts_at, ends_at from bans
      where account_id = $1 and lifted_at is null and starts_at <= now()
        and (permanent or ends_at > now())
        and ($2 = 'asking' or scope = 'all')
      order by permanent desc, ends_at desc nulls first
      limit 1`,
    [accountId, what],
  );
  return rows[0] ?? null;
}

export async function canAsk(accountId: number): Promise<boolean> {
  return !(await activeBan(accountId, "asking"));
}

// For the vote engine: a person banned from asking can still vote.
export async function canVote(accountId: number): Promise<boolean> {
  return !(await activeBan(accountId, "voting"));
}

export async function activePoints(accountId: number, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select coalesce(sum(points), 0)::int as n from demerits where account_id = $1 and revoked_at is null and expires_at > now()",
    [accountId],
  );
  return rows[0].n;
}

// Demerit bans in the last year that still stand (an overturned ban is lifted and doesn't count).
async function priorDemeritBans(accountId: number, db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from bans
      where account_id = $1 and cause = 'demerits' and lifted_at is null
        and created_at > now() - make_interval(days => $2)`,
    [accountId, BAN_MEMORY_DAYS],
  );
  return rows[0].n;
}

export type DemeritOutcome = { demeritId: number; points: number; ban: Ban | null };

// A demerit for a harmful question, and the ban it brings when the points reach the line.
export async function addDemerit(
  input: { accountId: number; kind: HarmKind; reason: string; questionId?: number | null; detail?: string | null; by?: number | null; points?: number },
  db?: Db,
): Promise<DemeritOutcome> {
  const run = async (client: Db): Promise<DemeritOutcome> => {
    // One at a time per account, so two quick demerits can't both read the same ladder step.
    await client.query("select pg_advisory_xact_lock(727275, $1)", [input.accountId]);
    const { rows } = await client.query<{ id: number }>(
      `insert into demerits (account_id, question_id, reason, points, created_by, expires_at, kind, detail)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8) returning id::int`,
      [input.accountId, input.questionId ?? null, input.reason.slice(0, 500), input.points ?? 1, input.by ?? null,
        DEMERIT_DAYS, input.kind, input.detail?.slice(0, 500) ?? null],
    );
    const demeritId = rows[0].id;
    await logDecision({
      subject: "demerit", subjectId: demeritId, action: "demerit", moderatorId: input.by ?? null,
      questionId: input.questionId ?? null, accountId: input.accountId, detail: input.kind,
    }, client);
    const points = await activePoints(input.accountId, client);
    let ban: Ban | null = null;
    if (points >= BAN_AT_POINTS) ban = await banFromAsking(input.accountId, input.by ?? null, client);
    return { demeritId, points, ban };
  };
  return db ? run(db) : transaction(run);
}

// The next temporary ban from asking. Never permanent: the ladder tops out.
async function banFromAsking(accountId: number, by: number | null, db: Db): Promise<Ban> {
  const days = banLengthDays(await priorDemeritBans(accountId, db));
  // A new ban starts now and runs `days` past any ban already in force, so it never shortens one.
  const { rows } = await db.query<Ban>(
    `insert into bans (account_id, scope, cause, permanent, reason, starts_at, ends_at, created_by)
     values ($1, 'asking', 'demerits', false, $2, now(),
             greatest(now(), coalesce((select max(ends_at) from bans where account_id = $1 and lifted_at is null and not permanent), now()))
               + make_interval(days => $3),
             $4)
     returning id::int, scope, cause, permanent, reason, starts_at, ends_at`,
    [accountId, `${days}-day ban from asking after repeated harmful questions`, days, by],
  );
  await logDecision({ subject: "ban", subjectId: rows[0].id, action: "ban", moderatorId: by, accountId, detail: `${days} days` }, db);
  return rows[0];
}

// After a demerit is revoked: if the points no longer reach the line, lift the demerit bans
// still in force. Earlier, finished bans are history and stay.
export async function recheckBans(accountId: number, by: number | null, db: Db): Promise<number> {
  if ((await activePoints(accountId, db)) >= BAN_AT_POINTS) return 0;
  const { rows } = await db.query<{ id: number }>(
    `update bans set lifted_at = now(), lifted_by = $2
      where account_id = $1 and cause = 'demerits' and lifted_at is null and ends_at > now()
      returning id::int`,
    [accountId, by],
  );
  for (const r of rows) await logDecision({ subject: "ban", subjectId: r.id, action: "lift", moderatorId: by, accountId, detail: "demerits revoked" }, db);
  return rows.length;
}

export async function liftBan(banId: number, by: number | null, db: Db, why = "appeal"): Promise<boolean> {
  const { rows } = await db.query<{ account_id: number }>(
    "update bans set lifted_at = now(), lifted_by = $2 where id = $1 and lifted_at is null returning account_id",
    [banId, by],
  );
  if (!rows[0]) return false;
  await logDecision({ subject: "ban", subjectId: banId, action: "lift", moderatorId: by, accountId: rows[0].account_id, detail: why }, db);
  return true;
}

export async function revokeDemerit(demeritId: number, by: number | null, db: Db, why = "appeal"): Promise<boolean> {
  const { rows } = await db.query<{ account_id: number; question_id: number | null }>(
    "update demerits set revoked_at = now() where id = $1 and revoked_at is null returning account_id, question_id",
    [demeritId],
  );
  if (!rows[0]) return false;
  await logDecision({
    subject: "demerit", subjectId: demeritId, action: "revoke", moderatorId: by,
    accountId: rows[0].account_id, questionId: rows[0].question_id, detail: why,
  }, db);
  await recheckBans(rows[0].account_id, by, db);
  return true;
}

// The only way to a permanent ban: vote manipulation, after a moderator confirmed the signal,
// for an account the signal names. Anything else is refused here and by the database.
export async function banForManipulation(accountId: number, signalId: number, by: number, db: Db): Promise<Ban> {
  const { rows: signal } = await db.query<{ ok: boolean }>(
    `select true as ok from manipulation_signals
      where id = $1 and outcome = 'confirmed'
        and (account_id = $2 or coalesce(detail->'accounts', '[]'::jsonb) @> to_jsonb(array[$2::int]))`,
    [signalId, accountId],
  );
  if (!signal[0]) throw new Error("A permanent ban needs a confirmed manipulation signal that names this account.");
  const { rows } = await db.query<Ban>(
    `insert into bans (account_id, scope, cause, permanent, reason, ends_at, created_by)
     values ($1, 'all', 'manipulation', true, $2, null, $3)
     returning id::int, scope, cause, permanent, reason, starts_at, ends_at`,
    [accountId, `Vote manipulation (signal #${signalId})`, by],
  );
  await logDecision({ subject: "ban", subjectId: rows[0].id, action: "ban_permanent", moderatorId: by, accountId, detail: `signal ${signalId}` }, db);
  return rows[0];
}
