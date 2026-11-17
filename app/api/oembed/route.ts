import { baseUrl, brandName, EMBED_SIZE, embedHtml, questionIdFromUrl } from "@/lib/front-door";
import { getQuestion } from "@/lib/questions";

// GET /api/oembed?url=<a BeliefAtlas question link>&format=json
//
// The oEmbed endpoint. Sites and tools that support oEmbed (WordPress, Notion, Ghost,
// iframely and others) turn a pasted BeliefAtlas link into the live embed. Each vote page links
// here with <link rel="alternate" type="application/json+oembed">.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if ((params.get("format") ?? "json") !== "json") {
    return Response.json({ error: "Only JSON is supported." }, { status: 501 });
  }
  const questionId = questionIdFromUrl(params.get("url") ?? "");
  const question = questionId ? await getQuestion(questionId) : null;
  if (!question) return Response.json({ error: "Not a BeliefAtlas question link." }, { status: 404 });

  const maxWidth = Number(params.get("maxwidth")) || Infinity;
  const width = Math.min(EMBED_SIZE.width, maxWidth);
  return Response.json(
    {
      version: "1.0",
      type: "rich",
      provider_name: brandName(),
      provider_url: baseUrl(),
      title: question.text,
      html: embedHtml(question.id, question.text).replace(`width="${EMBED_SIZE.width}"`, `width="${width}"`),
      width,
      height: EMBED_SIZE.height,
      thumbnail_url: `${baseUrl()}/v/${question.id}/opengraph-image`,
      thumbnail_width: 1200,
      thumbnail_height: 630,
      cache_age: 3600,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
