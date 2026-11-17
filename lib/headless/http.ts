import { hit, RULES, tooMany } from "../rate-limit";
import { ipFromRequest } from "../request";
import { headlessEnabled } from "./config";

// Small helpers shared by the /api/headless/v1 routes.

export const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const errorBody = (error: string, message: string) => ({ error, message });

// Switched off, the routes look like they don't exist.
export function offResponse(): Response | null {
  return headlessEnabled() ? null : json(errorBody("not_found", "Not found."), 404);
}

// The per-IP allowance for public reads.
export async function readLimit(request: Request, headers: Record<string, string> = {}): Promise<Response | null> {
  const limited = await hit([RULES.headlessReadPerIp, ipFromRequest(request)]);
  return limited ? json(errorBody("slow_down", tooMany(limited)), 429, headers) : null;
}

export function preflight(headers: Record<string, string> = PUBLIC_CORS): Response {
  return new Response(null, { status: headlessEnabled() ? 204 : 404, headers: headlessEnabled() ? headers : {} });
}
