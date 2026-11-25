// Wire a question for vote evidence (E1), or take it off again. Only wired questions keep the
// extra per-action record in vote_evidence; see lib/evidence.ts.
//   npm run evidence:wire -- <question id> [note]
//   npm run evidence:wire -- --off <question id>
//   npm run evidence:wire -- --list
import { pool, query } from "../lib/db";
import { unwireQuestion, wireQuestion, wiredQuestions } from "../lib/evidence";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    const ids = await wiredQuestions();
    console.log(ids.length ? `Wired: ${ids.join(", ")}` : "No questions are wired.");
  } else {
    const off = args[0] === "--off";
    const id = Number(off ? args[1] : args[0]);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Usage: npm run evidence:wire -- [--off] <question id> [note] | --list");
    const [q] = await query<{ text: string; status: string }>("select text, status from questions where id = $1", [id]);
    if (!q) throw new Error(`No question ${id}.`);
    if (off) {
      await unwireQuestion(id);
      console.log(`Question ${id} is no longer wired: "${q.text}"`);
    } else {
      await wireQuestion(id, args.slice(1).join(" ") || null);
      console.log(`Question ${id} is wired (${q.status}): "${q.text}"`);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
