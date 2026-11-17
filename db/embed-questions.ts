// Store meaning vectors for every question text (canonical and approved translations) that has
// none yet, so search can match by meaning. Off unless EMBEDDINGS_URL points at a self-hosted
// embeddings service; safe to re-run.
//   npm run embeddings:index -- --limit 2000
import { pool } from "../lib/db";
import { embeddingsEnabled, indexEmbeddings } from "../lib/embeddings";

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--limit");
  const limit = i >= 0 ? Number(args[i + 1]) : 500;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a whole number above 0.");
  if (!embeddingsEnabled()) {
    console.log("Meaning-based search is off: set EMBEDDINGS_URL to a self-hosted embeddings service to turn it on.");
    return;
  }
  const run = await indexEmbeddings({ limit });
  console.log(`${run.indexed} texts indexed, ${run.failed} failed.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
