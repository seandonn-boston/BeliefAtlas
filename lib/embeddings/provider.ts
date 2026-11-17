// Meaning-based search turns text into vectors. The provider is any self-hosted embeddings
// service; nothing paid, and no key in code. It is off unless EMBEDDINGS_URL is set, and with it
// off search uses trigram matching alone.
//
//   EMBEDDINGS_URL       the endpoint to POST to, e.g. http://localhost:8080/v1/embeddings
//                        (text-embeddings-inference, Ollama, llama.cpp's server and LocalAI all
//                        speak this OpenAI-style shape; TEI's /embed is understood too)
//   EMBEDDINGS_MODEL     the model name to send and to label stored vectors with (default "default")
//   EMBEDDINGS_TOKEN     optional bearer token, if the service sits behind one
//   EMBEDDINGS_TIMEOUT_MS how long to wait before falling back to trigram search (default 4000)
//
// A multilingual model (e.g. multilingual-e5 or bge-m3) also matches across languages, so a
// question asked in Spanish can find an English one that has no translation yet.

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

type Env = Record<string, string | undefined>;

export function embeddingsEnabled(env: Env = process.env): boolean {
  return Boolean(env.EMBEDDINGS_URL?.trim());
}

// Pull the vectors out of whichever response shape the service uses.
export function parseEmbeddings(body: unknown, expected: number): number[][] {
  const pick = (): unknown[] | null => {
    if (Array.isArray(body)) return body;                                   // TEI /embed: [[...], ...]
    if (body && typeof body === "object") {
      const o = body as Record<string, unknown>;
      if (Array.isArray(o.data)) return o.data.map((d) => (d as { embedding?: unknown }).embedding); // OpenAI-style
      if (Array.isArray(o.embeddings)) return o.embeddings;                  // Ollama /api/embed
    }
    return null;
  };
  const vectors = pick();
  if (!vectors || vectors.length !== expected) throw new Error("embeddings: unexpected response shape");
  return vectors.map((v) => {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error("embeddings: a vector wasn't a list of numbers");
    }
    return v as number[];
  });
}

export class HttpEmbedder implements Embedder {
  readonly model: string;
  constructor(private readonly url: string, model?: string, private readonly token?: string, private readonly timeoutMs = 4000) {
    this.model = model?.trim() || "default";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      // TEI's own /embed takes `inputs`; everything OpenAI-style takes `model` and `input`.
      body: JSON.stringify(/\/embed\/?$/.test(new URL(this.url).pathname) ? { inputs: texts } : { model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`embeddings: ${response.status}`);
    return parseEmbeddings(await response.json(), texts.length);
  }
}

// The configured provider, or null when meaning-based search is off.
export function getEmbedder(env: Env = process.env): Embedder | null {
  if (!embeddingsEnabled(env)) return null;
  return new HttpEmbedder(
    env.EMBEDDINGS_URL!.trim(),
    env.EMBEDDINGS_MODEL,
    env.EMBEDDINGS_TOKEN || undefined,
    Number(env.EMBEDDINGS_TIMEOUT_MS) || 4000,
  );
}
