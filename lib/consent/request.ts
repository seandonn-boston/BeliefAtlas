import { headers } from "next/headers";
import { getLocale } from "../i18n/request";
import { contextFromHeaders, type ConsentContext } from "./context";

// The consent context of the current request (pages, server actions, route handlers).
export async function requestContext(surface: string): Promise<ConsentContext> {
  const [h, lang] = await Promise.all([headers(), getLocale()]);
  return contextFromHeaders(h, surface, lang);
}

// The same, from a Request object (route handlers that already have one).
export function contextFromRequest(request: Request, surface: string, lang = "en"): ConsentContext {
  return contextFromHeaders(request.headers, surface, lang);
}
