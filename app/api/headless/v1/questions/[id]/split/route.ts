import { errorBody, json, offResponse, preflight, PUBLIC_CORS, readLimit } from "@/lib/headless/http";
import { getQuestion } from "@/lib/questions";
import { percentages, tallies } from "@/lib/stats";

// GET /api/headless/v1/questions/:id/split — percentages only, the same a signed-out visitor
// sees on the question page. Cards don't carry this: an SDK fetches it after a vote counted,
// so the first answer is blind.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const off = offResponse();
  if (off) return off;
  const limited = await readLimit(request, PUBLIC_CORS);
  if (limited) return limited;
  const questionId = Number((await params).id);
  if (!Number.isInteger(questionId) || questionId <= 0) return json(errorBody("invalid", "Invalid question id."), 400, PUBLIC_CORS);
  const question = await getQuestion(questionId);
  if (!question) return json(errorBody("not_found", "Question not found."), 404, PUBLIC_CORS);
  const tally = (await tallies([questionId])).get(questionId)!;
  return json({ questionId, hasVotes: tally.total > 0, percentages: percentages(tally) }, 200, PUBLIC_CORS);
}

export const OPTIONS = () => preflight();
