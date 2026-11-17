import { NextResponse, type NextRequest } from "next/server";
import { blockedPlaceFor, unavailableHtml, unavailableJson, unavailableLocale } from "@/lib/sanctions/unavailable";

// Runs before every page and API route. A visitor in a blocked place (Iran, North Korea, Cuba,
// Russia, Belarus, and occupied Crimea, Sevastopol, Donetsk and Luhansk; the list is
// lib/sanctions/places.ts) gets one plain "not available here" answer with status 451 for
// everything: pages, voting, signup, sign-in, embeds and the API. There is no exemption for
// free communications.
//
// The location comes from Vercel's free x-vercel-ip-country and x-vercel-ip-country-region
// headers. A VPN gets round it; that is a question for the lawyer (lawyer-brief.md).
export function proxy(request: NextRequest) {
  if (!blockedPlaceFor(request)) return NextResponse.next();
  const locale = unavailableLocale(request);
  const headers = { "cache-control": "no-store", vary: "x-vercel-ip-country, x-vercel-ip-country-region" };
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(unavailableJson(locale), { status: 451, headers });
  }
  return new NextResponse(unavailableHtml(locale), {
    status: 451,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

// Everything except Next's own static files and the health check that uptime monitoring uses.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
