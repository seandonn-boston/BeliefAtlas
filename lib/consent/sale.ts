import { createHmac } from "crypto";
import { query } from "../db";
import { assertNoSeedData } from "../provenance";
import { SALE_ELIGIBLE_ACCOUNTS } from "../regions";
import { UNOFFICIAL_NOTICE } from "../legal";

// The one way to read person-level answers for a sale. Nothing is sold yet: this exists so the
// first export is built on the right rules rather than written from scratch. It refuses to run
// at all while any seed data is left (lib/provenance.ts assertNoSeedData), and includes only:
//   * real people's answers (origin 'real' on the account and on the vote), never test or seed;
//   * accounts that pass SALE_ELIGIBLE_ACCOUNTS (agreed to answering, opted in to sale without
//     GPC, in a region open to sale, not deleted);
//   * public answers (an answer marked private is never sold);
//   * questions that are active: never archived, removed, merged away or still in review.
// People appear under a key derived from the export's own salt, so two exports can't be joined
// on it and the key never leads back to an account id.

export type SaleRow = {
  person: string;
  questionId: number;
  value: "true" | "false" | "unsure";
  firstValue: "true" | "false" | "unsure" | null;
  answeredAt: Date;
  updatedAt: Date;
};

export type SaleExportOptions = {
  salt: string;              // a fresh random value per export, never stored with the output
  questionIds?: number[];    // limit to these questions
  limit?: number;
};

export const SALE_EXPORT_SQL = `
  select v.account_id, v.question_id, v.value, v.first_value, v.first_cast_at, v.updated_at
    from votes v
    join questions q on q.id = v.question_id
   where v.account_id in (${SALE_ELIGIBLE_ACCOUNTS})
     and v.origin = 'real'
     and not v.is_private
     and q.status = 'active'
     and q.archived_at is null
     and not exists (select 1 from question_merges m where m.from_question_id = q.id)
     and ($1::int[] is null or v.question_id = any($1::int[]))
   order by v.question_id, v.account_id
   limit $2`;

// What a buyer receives: the rows, with the unofficial notice on the file itself, so it travels
// with the data wherever the file goes.
export async function saleExportFile(opts: SaleExportOptions) {
  const rows = await saleExportRows(opts);
  return { notice: UNOFFICIAL_NOTICE, generatedAt: new Date().toISOString(), rows };
}

export async function saleExportRows(opts: SaleExportOptions): Promise<SaleRow[]> {
  if (!opts.salt || opts.salt.length < 16) throw new Error("A sale export needs its own random salt of 16+ characters.");
  await assertNoSeedData();
  const rows = await query<{
    account_id: number; question_id: number; value: SaleRow["value"]; first_value: SaleRow["firstValue"];
    first_cast_at: Date; updated_at: Date;
  }>(SALE_EXPORT_SQL, [opts.questionIds ?? null, opts.limit ?? 100_000]);
  const key = (id: number) => createHmac("sha256", opts.salt).update(String(id)).digest("base64url").slice(0, 22);
  return rows.map((r) => ({
    person: key(r.account_id),
    questionId: r.question_id,
    value: r.value,
    firstValue: r.first_value,
    answeredAt: r.first_cast_at,
    updatedAt: r.updated_at,
  }));
}
