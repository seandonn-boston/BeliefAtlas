"use client";

import { useEffect, useState } from "react";

// Share a question without leaving the page: the phone's share sheet where there is one
// (it reaches every messaging and social app installed), otherwise copy the link.
export function ShareButton({ url, text, className = "btn" }: { url: string; text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: text, text: `${text} True or false?`, url });
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return; // they closed the sheet
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  return (
    <button type="button" className={className} onClick={share}>
      {copied ? "Link copied" : "Share"}
    </button>
  );
}

// After a vote in a popup that an embed opened, tell the embed (same site only) so it can
// show the confirmation in place, then close.
export function TellOpener({ message, origin, close }: { message: Record<string, unknown>; origin: string; close: boolean }) {
  const payload = JSON.stringify(message);
  useEffect(() => {
    if (!window.opener || window.opener.closed) return;
    try {
      window.opener.postMessage({ type: "beliefatlas:voted", ...JSON.parse(payload) }, origin);
    } catch {
      return; // the opener is on another site; nothing to tell
    }
    if (!close) return;
    const timer = setTimeout(() => window.close(), 1200);
    return () => clearTimeout(timer);
  }, [payload, origin, close]);
  return null;
}
