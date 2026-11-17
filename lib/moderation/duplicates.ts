import { query, transaction } from "../db";
import { logDecision } from "./log";
import { mergeQuestions, type MergeError } from "./merge";

// Duplicates that slip through. Prevent them before they're asked wherever possible (the
// search page and the exact-match refusal in lib/questions.ts do that). When two questions
// still look like the same question, the pair goes to a moderator, and neither is hidden: both
// keep taking answers while they wait. Pairs come from:
//   ask        a new question whose nearest match is close (DUPLICATE_SUSPECT_SIMILARITY or
//              more) but not the same text
//   report     a "repeats another question" report, naming the question or, failing that,
//              its nearest close match
//   moderator  a moderator pairing two questions from the queue
//
// The moderator decides with the owner's test, "does the data tell two different stories":
//   not duplicates  dismissed, and the pair is remembered so it is never suggested again
//   merge           same subject, same polarity
//   merge inverted  same subject, only the polarity differs: the repeat's No counts as Yes
// Different subjects stay apart, even two halves of one coin ("did the Democrats win" and
// "did the Republicans lose" call two different nouns into question).

export const DUPLICATE_SUSPECT_SIMILARITY = Number(process.env.DUPLICATE_SUSPECT_SIMILARITY ?? 0.5);

export type SuspectSource = "ask" | "report" | "moderator";
export type SuggestOutcome = "suggested" | "again" | "settled" | "invalid";

// Put a pair in the queue. A pair is stored once, ever: suggesting an open pair again counts
// another suggestion; a pair already dismissed or merged is left as it is.
export async function suggestDuplicate(input: {
  a: number; b: number; source: SuspectSource; similarity?: number | null; by?: number | null;
}): Promise<SuggestOutcome> {
  const { a, b } = input;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return "invalid";
  const live = await query<{ id: number }>(
    "select id from questions where id = any($1::int[]) and status in ('active', 'review', 'archived')",
    [[a, b]],
  );
  if (live.length !== 2) return "invalid";
  const rows = await query<{ inserted: boolean; status: string }>(
    `insert into duplicate_suspects (question_a, question_b, source, similarity, suggested_by)
     values (least($1::int, $2::int), greatest($1::int, $2::int), $3, $4, $5)
     on conflict (question_a, question_b) do update
       set times_suggested = duplicate_suspects.times_suggested + 1,
           similarity = greatest(duplicate_suspects.similarity, excluded.similarity)
       where duplicate_suspects.status = 'open'
     returning (xmax = 0) as inserted, status`,
    [a, b, input.source, input.similarity ?? null, input.by ?? null],
  );
  if (!rows[0]) return "settled";
  return rows[0].inserted ? "suggested" : "again";
}

// At ask time: the new question's close matches (not exact; an exact match is refused before
// this) go to the queue. The new question is posted as usual.
export async function suspectsAtAsk(
  newId: number, matches: { id: number; status: string; similarity: number }[],
): Promise<number> {
  let n = 0;
  const close = matches
    .filter((m) => m.id !== newId && m.status === "active" && m.similarity >= DUPLICATE_SUSPECT_SIMILARITY)
    .slice(0, 3);
  for (const m of close) {
    if ((await suggestDuplicate({ a: newId, b: m.id, source: "ask", similarity: m.similarity })) === "suggested") n++;
  }
  return n;
}

// The closest other live question, if it's close enough to be a suspected duplicate.
export async function nearestCloseMatch(questionId: number): Promise<{ id: number; similarity: number } | null> {
  const rows = await query<{ id: number; similarity: number }>(
    `select o.id, similarity(o.normalized, q.normalized)::float as similarity
       from questions q join questions o on o.id <> q.id and o.status in ('active', 'review') and o.normalized % q.normalized
      where q.id = $1
      order by similarity desc, o.id
      limit 1`,
    [questionId],
  );
  const best = rows[0];
  return best && best.similarity >= DUPLICATE_SUSPECT_SIMILARITY ? best : null;
}

// ---------- The queue ----------

export type SuspectSide = {
  id: number; text: string; status: string; votes: number; created_at: Date; asked_by_user: boolean;
};
export type SuspectPair = {
  id: number; source: SuspectSource; similarity: number | null; times_suggested: number; created_at: Date;
  a: SuspectSide; b: SuspectSide;
};

// Open pairs, oldest first. Vote counts only, never the true/false split, so a decision can't
// lean on which way people answered.
export async function duplicatesQueue(limit = 50): Promise<SuspectPair[]> {
  return query<SuspectPair>(
    `select s.id::int, s.source, s.similarity, s.times_suggested, s.created_at,
            json_build_object('id', a.id, 'text', a.text, 'status', a.status, 'votes', a.total_count,
                              'created_at', a.created_at, 'asked_by_user', a.asked_by is not null) as a,
            json_build_object('id', b.id, 'text', b.text, 'status', b.status, 'votes', b.total_count,
                              'created_at', b.created_at, 'asked_by_user', b.asked_by is not null) as b
       from duplicate_suspects s
       join questions a on a.id = s.question_a
       join questions b on b.id = s.question_b
      where s.status = 'open' and a.status <> 'removed' and b.status <> 'removed'
      order by s.times_suggested desc, s.created_at
      limit $1`,
    [limit],
  );
}

export type DuplicateDecision =
  | { action: "dismiss" }
  | { action: "merge"; inverted: boolean; keep: number };   // keep: the question that stays
export type DuplicateDecisionError = MergeError | "not_found" | "decided" | "keep_not_in_pair";

export async function decideDuplicate(
  moderatorId: number, pairId: number, decision: DuplicateDecision,
): Promise<DuplicateDecisionError | null> {
  const [pair] = await query<{ question_a: number; question_b: number; status: string }>(
    "select question_a, question_b, status from duplicate_suspects where id = $1", [pairId],
  );
  if (!pair) return "not_found";
  if (pair.status !== "open") return "decided";

  if (decision.action === "dismiss") {
    return transaction(async (client) => {
      const { rows } = await client.query(
        `update duplicate_suspects set status = 'dismissed', decided_by = $2, decided_at = now(), rule_id = 'dup_different_subject'
          where id = $1 and status = 'open' returning id`,
        [pairId, moderatorId],
      );
      if (!rows.length) return "decided";
      await logDecision({
        subject: "question", subjectId: pair.question_b, action: "not_duplicate", moderatorId,
        ruleId: "dup_different_subject", detail: String(pair.question_a),
      }, client);
      return null;
    });
  }

  const { keep } = decision;
  if (keep !== pair.question_a && keep !== pair.question_b) return "keep_not_in_pair";
  const from = keep === pair.question_a ? pair.question_b : pair.question_a;
  const merged = await mergeQuestions(moderatorId, from, keep, { inverted: decision.inverted });
  return merged.ok ? null : merged.error;
}
