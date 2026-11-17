import { unavailableHtml, unavailableLocale } from "@/lib/sanctions/unavailable";
import type { NextRequest } from "next/server";

// A preview of the page visitors in a blocked place see, so it can be checked from anywhere.
export function GET(request: NextRequest) {
  return new Response(unavailableHtml(unavailableLocale(request)), {
    headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
