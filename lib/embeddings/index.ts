import { query } from "../db";
import { getEmbedder, type Embedder } from "./provider";

export { embeddingsEnabled, getEmbedder, HttpEmbedder, parseEmbeddings, type Embedder } from "./provider";

// Meaning-based search over the catalog, in every language. Vectors live in
// question_embeddings (one per question per language per model: the canonical text and each
// approved translation) and are compared with cm_cosine() in Postgres, so no extension is needed.
// Off unless EMBEDDINGS_URL is set; every function here then does nothing and search falls back
// to trigram matching. A slow or broken service also falls back, never fails a search.

export type MeaningMatch = {
  id: number;             // always the canonical question id
  text: string;           // the text that matched (canonical, or an approved translation)
  lang: string;           // the language of `text`
  status: string;
  category: string;
  created_at: Date;
  similarity: number;     // cosine similarity, 0..1 for the usual normalized models
};

const minSimilarity = () => Number(process.env.EMBEDDINGS_MIN_SIMILARITY) || 0.82;

// Only vectors made from text that is still current count: a canonical text, or a translation
// that is still approved with the same words. Anything else waits for the next index run.
const CURRENT = `
  (e.lang = q.lang and e.source_text = q.text)
  or exists (select 1 from question_translations t
              where t.question_id = e.question_id and t.lang = e.lang
                and t.status = 'approved' and t.text = e.source_text)`;

export async function meaningMatches(text: string, limit = 10, embedder: Embedder | null = getEmbedder()): Promise<MeaningMatch[]> {
  if (!embedder || !text.trim()) return [];
  try {
    const [vector] = await embedder.embed([text.trim()]);
    return await query<MeaningMatch>(
      `select id, text, lang, status, category, created_at, similarity from (
         select distinct on (q.id) q.id, e.source_text as text, e.lang, q.status, q.category, q.created_at,
                cm_cosine(e.embedding, $1::real[]) as similarity
           from question_embeddings e join questions q on q.id = e.question_id
          where e.model = $2 and q.status in ('active', 'archived') and (${CURRENT})
          order by q.id, similarity desc
       ) best
       where similarity >= $3
       order by similarity desc, created_at
       limit $4`,
      [vector, embedder.model, minSimilarity(), limit],
    );
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "embeddings search fell back to trigram", error: (err as Error).message }));
    return [];
  }
}

// Embed every current text that has no vector yet for this model. Run from
// `npm run embeddings:index`; safe to re-run, and picks up newly approved translations.
export async function indexEmbeddings(
  { limit = 500, batch = 32 }: { limit?: number; batch?: number } = {},
  embedder: Embedder | null = getEmbedder(),
): Promise<{ enabled: boolean; indexed: number; failed: number }> {
  if (!embedder) return { enabled: false, indexed: 0, failed: 0 };
  const missing = await query<{ id: number; lang: string; text: string }>(
    `select * from (
       select q.id, q.lang, q.text from questions q
        where q.status in ('active', 'archived')
       union all
       select t.question_id, t.lang, t.text from question_translations t
         join questions q on q.id = t.question_id
        where t.status = 'approved' and q.status in ('active', 'archived')
     ) texts
     where not exists (select 1 from question_embeddings e
                        where e.question_id = texts.id and e.lang = texts.lang
                          and e.model = $1 and e.source_text = texts.text)
     order by id
     limit $2`,
    [embedder.model, limit],
  );
  let indexed = 0, failed = 0;
  for (let i = 0; i < missing.length; i += batch) {
    const chunk = missing.slice(i, i + batch);
    try {
      const vectors = await embedder.embed(chunk.map((c) => c.text));
      for (const [j, c] of chunk.entries()) {
        await query(
          `insert into question_embeddings (question_id, lang, model, embedding, source_text)
           values ($1, $2, $3, $4::real[], $5)
           on conflict (question_id, lang, model)
           do update set embedding = excluded.embedding, source_text = excluded.source_text, updated_at = now()`,
          [c.id, c.lang, embedder.model, vectors[j], c.text],
        );
        indexed++;
      }
    } catch (err) {
      failed += chunk.length;
      console.warn(JSON.stringify({ level: "warn", msg: "embeddings batch failed", error: (err as Error).message }));
    }
  }
  return { enabled: true, indexed, failed };
}
