import { pool, query, transaction } from "../db";
import { banForManipulation } from "./bans";
import { logDecision } from "./log";

// Signals of coordinated or fake voting, read from vote_events. The one signal so far:
//
//   new_account_burst - at least MIN_ACCOUNTS accounts, each younger than NEW_ACCOUNT_DAYS when
//   it voted, cast the same answer on one question within WINDOW_MINUTES.
//
// A signal is only a lead. A moderator confirms or dismisses it; confirming can permanently ban
// the accounts in the burst, and only them. Nobody else is ever banned for it: not the asker
// whose question was targeted, not the people who answered it honestly.
//
// The scan is cheap and safe to run often. It runs from the moderator page; a scheduled job
// can call scanForManipulation() too.

export const MANIPULATION = {
  windowMinutes: Number(process.env.MANIPULATION_WINDOW_MINUTES ?? 10),
  minAccounts: Number(process.env.MANIPULATION_MIN_ACCOUNTS ?? 8),
  newAccountDays: Number(process.env.MANIPULATION_NEW_ACCOUNT_DAYS ?? 7),
  lookbackHours: Number(process.env.MANIPULATION_LOOKBACK_HOURS ?? 24),
};

export type SignalDetail = {
  accounts: number[];
  value: string;            // which answer the burst gave; used to find it, never shown to moderators
  window_start: string;
  window_end: string;
  window_minutes: number;
  new_account_days: number;
};

type Burst = { question_id: number; value: string; window_start: Date; window_end: Date; accounts: number[] };

export async function scanForManipulation(opts: Partial<typeof MANIPULATION> = {}): Promise<number> {
  const o = { ...MANIPULATION, ...opts };
  const bursts = await query<Burst>(
    `with casts as (
       select e.question_id, e.account_id, e.value, e.created_at
         from vote_events e join accounts a on a.id = e.account_id
        where e.action = 'cast' and e.value is not null
          and e.created_at > now() - make_interval(hours => $1)
          and a.created_at > e.created_at - make_interval(days => $2)
     ), windows as (
       select c.question_id, c.value, c.created_at as window_start, max(d.created_at) as window_end,
              array_agg(distinct d.account_id) as accounts
         from casts c
         join casts d on d.question_id = c.question_id and d.value = c.value
                     and d.created_at >= c.created_at and d.created_at < c.created_at + make_interval(mins => $3)
        group by c.question_id, c.value, c.created_at
       having count(distinct d.account_id) >= $4
     )
     select distinct on (question_id, value) question_id, value, window_start, window_end, accounts
       from windows
      order by question_id, value, cardinality(accounts) desc, window_start`,
    [o.lookbackHours, o.newAccountDays, o.windowMinutes, o.minAccounts],
  );

  let created = 0;
  for (const b of bursts) {
    const detail: SignalDetail = {
      accounts: [...b.accounts].sort((x, y) => x - y), value: b.value,
      window_start: b.window_start.toISOString(), window_end: b.window_end.toISOString(),
      window_minutes: o.windowMinutes, new_account_days: o.newAccountDays,
    };
    // One signal per question and answer while it's open: a growing burst updates it. A burst
    // already reviewed isn't raised again inside the lookback window.
    const [existing] = await query<{ id: number; reviewed: boolean; accounts: number[] }>(
      `select id::int, reviewed_at is not null as reviewed,
              array(select jsonb_array_elements_text(detail->'accounts')::int) as accounts
         from manipulation_signals
        where question_id = $1 and kind = 'new_account_burst' and detail->>'value' = $2
          and created_at > now() - make_interval(hours => $3)
        order by created_at desc limit 1`,
      [b.question_id, b.value, o.lookbackHours],
    );
    if (existing?.reviewed) continue;
    if (existing) {
      const union = [...new Set([...existing.accounts, ...detail.accounts])].sort((x, y) => x - y);
      if (union.length > existing.accounts.length) {
        await query("update manipulation_signals set detail = $2 where id = $1", [existing.id, JSON.stringify({ ...detail, accounts: union })]);
      }
      continue;
    }
    await query(
      "insert into manipulation_signals (question_id, kind, detail) values ($1, 'new_account_burst', $2)",
      [b.question_id, JSON.stringify(detail)],
    );
    created++;
  }
  return created;
}

// Open signals for the moderator queue. The answer the burst gave is left out on purpose: the
// moderator view never shows which way a question is leaning.
export type OpenSignal = {
  id: number; question_id: number | null; question_text: string | null; kind: string; accounts: number; account_ids: number[];
  window_minutes: number; new_account_days: number; window_start: string; created_at: Date; votes: number | null;
};

export async function openSignals(limit = 50): Promise<OpenSignal[]> {
  const { rows } = await pool.query<OpenSignal>(
    `select s.id::int, s.question_id, q.text as question_text, s.kind,
            jsonb_array_length(coalesce(s.detail->'accounts', '[]'::jsonb)) as accounts,
            array(select jsonb_array_elements_text(coalesce(s.detail->'accounts', '[]'::jsonb))::int) as account_ids,
            coalesce((s.detail->>'window_minutes')::int, 0) as window_minutes,
            coalesce((s.detail->>'new_account_days')::int, 0) as new_account_days,
            s.detail->>'window_start' as window_start, s.created_at, q.total_count as votes
       from manipulation_signals s left join questions q on q.id = s.question_id
      where s.reviewed_at is null
      order by s.created_at
      limit $1`,
    [limit],
  );
  return rows;
}

export type SignalError = "not_found" | "reviewed";

// Confirm or dismiss. Confirming bans permanently the accounts in the burst that the moderator
// keeps ticked (all of them by default), never anyone outside it.
export async function reviewSignal(
  moderatorId: number, signalId: number, outcome: "confirmed" | "dismissed", banAccounts?: number[],
): Promise<{ ok: true; banned: number } | { ok: false; error: SignalError }> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ account_id: number | null; detail: SignalDetail | null; reviewed_at: Date | null; question_id: number | null }>(
      "select account_id, detail, reviewed_at, question_id from manipulation_signals where id = $1 for update",
      [signalId],
    );
    const signal = rows[0];
    if (!signal) return { ok: false, error: "not_found" } as const;
    if (signal.reviewed_at) return { ok: false, error: "reviewed" } as const;
    await client.query(
      "update manipulation_signals set reviewed_at = now(), reviewed_by = $2, outcome = $3 where id = $1",
      [signalId, moderatorId, outcome],
    );
    await logDecision({
      subject: "signal", subjectId: signalId, action: `signal_${outcome}`, moderatorId, questionId: signal.question_id,
      accountId: signal.account_id,
    }, client);
    if (outcome === "dismissed") return { ok: true, banned: 0 } as const;

    const named = new Set([...(signal.detail?.accounts ?? []), ...(signal.account_id ? [signal.account_id] : [])]);
    const chosen = (banAccounts ?? [...named]).filter((id) => named.has(id) && id !== moderatorId);
    let banned = 0;
    for (const accountId of chosen) {
      const already = await client.query("select 1 from bans where account_id = $1 and permanent and lifted_at is null", [accountId]);
      if (already.rows.length) continue;
      await banForManipulation(accountId, signalId, moderatorId, client);
      banned++;
    }
    return { ok: true, banned } as const;
  });
}
