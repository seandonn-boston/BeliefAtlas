import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { aiHeadEnabled, CONSENT_VERSION } from "@/lib/ai-head/config";
import { checkAuthorizeRequest, denyRedirect } from "@/lib/ai-head/oauth";
import { getAccount } from "@/lib/auth";
import { authorizeAction } from "./actions";

// /oauth/authorize: where a person, signed in to BeliefAtlas as themselves, lets an AI assistant
// (Claude, for now) show them BeliefAtlas cards and send the answers they tap
// (belief-map/claude-plugin.md, section 3). The assistant never gets an account and never votes.
// The words are a draft until a lawyer has read them. English only for now.

export const metadata: Metadata = { title: "Link BeliefAtlas to an assistant · BeliefAtlas", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function AuthorizePage({ searchParams }: Props) {
  if (!aiHeadEnabled()) notFound();
  const params = await searchParams;
  const account = await getAccount();
  if (!account) {
    const here = `/oauth/authorize?${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"))}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }
  const check = await checkAuthorizeRequest(params);
  if (!check.ok && "redirectUri" in check) redirect(denyRedirect(check.redirectUri, check.redirectError, check.state));

  return (
    <>
      <Header />
      <main className="wrap wrap-narrow">
        <h1 className="page-title">Link BeliefAtlas to {check.ok ? check.request.client.clientName : "an assistant"}</h1>
        {!check.ok ? (
          <p className="error" role="alert">{check.showError}</p>
        ) : (
          <>
            <p className="notice" role="note">Draft wording ({CONSENT_VERSION}), until it has been reviewed.</p>
            <p>You&rsquo;re signed in as <strong>{account.username}</strong>. If you allow this:</p>
            <ul>
              <li>{check.request.client.clientName} can show you BeliefAtlas questions and live results in your chats.</li>
              <li>Only your own tap on a BeliefAtlas card counts as an answer. The assistant can&rsquo;t answer, sign in or vote for you.</li>
              <li>The card tells the assistant what you picked, unless you tick &ldquo;Keep my answer from Claude&rdquo; on that card. Your answers to questions about politics, religion or health are sensitive: only share what you&rsquo;re comfortable with.</li>
              <li>Your usual limits still apply, and you can unlink at any time.</li>
            </ul>
            <form action={authorizeAction} className="actions">
              {Object.entries(params).map(([k, v]) => (typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
              <button type="submit" name="decision" value="allow" className="btn solid">Allow</button>{" "}
              <button type="submit" name="decision" value="deny" className="btn">Don&rsquo;t allow</button>
            </form>
          </>
        )}
      </main>
    </>
  );
}
