import type { Instrumentation } from "next";
import { logger, requestIdFrom } from "./lib/log";

// Server start-up and server errors, as structured JSON lines through lib/log.ts (which
// redacts phone numbers, tokens, codes, passwords, cookies and authorization headers).
//
// Error tracking is self-contained: errors go to the logs and nowhere else. DEPLOY.md
// describes how a free or self-hosted tracker could be added later behind a flag that is
// off by default. Nothing here sends data to a third party.

export function register() {
  logger.info("server starting", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    region: process.env.VERCEL_REGION,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12),
  });
}

// Called by Next for errors in server components, route handlers, server actions and proxy.
// Logs where it happened (route and digest) and what was thrown. Request bodies are never
// available here, and of the headers only the request id is read; the query string is cut
// from the path because it can carry codes and tokens.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : "non-error thrown");
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined;
  logger.error("request failed", {
    requestId: requestIdFrom(request.headers),
    route: context.routePath,
    digest,
    kind: context.routeType,
    router: context.routerKind,
    renderSource: "renderSource" in context ? context.renderSource : undefined,
    revalidateReason: context.revalidateReason,
    method: request.method,
    path: request.path.split("?")[0],
    error,
  });
};
