import Link from "next/link";
import { askAction } from "@/app/actions";
import type { CheckedQuestion } from "@/lib/checks";

type Props = {
  checked: CheckedQuestion;
  signedIn: boolean;
  dismissed: boolean;     // they pressed No on the suggestion for this text
  hasMatches: boolean;
  back: string;
};

const searchFor = (text: string, extra = "") => `/search?q=${encodeURIComponent(text)}${extra}`;

// What they typed, with each problem marked where it is and numbered to match its reason.
function Marked({ checked }: { checked: CheckedQuestion }) {
  const spans = checked.results
    .map((r, i) => ({ ...r.span!, n: i + 1, has: Boolean(r.span) }))
    .filter((s) => s.has)
    .sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    if (s.start > at) parts.push(checked.text.slice(at, s.start));
    parts.push(<mark key={s.n} className="fix-mark">{checked.text.slice(s.start, s.end)}<sup>{s.n}</sup></mark>);
    at = s.end;
  }
  parts.push(checked.text.slice(at));
  return <p className="ask-text">{parts}</p>;
}

// Sean's rule: when a question has to change, say why, show where and offer a fix. One box
// serves every check: Yes posts the suggestion, No goes back to what they wrote, Edit puts the
// suggestion in the search box to change further.
export function DidYouMean({ checked, signedIn, dismissed, hasMatches, back }: Props) {
  const { results, suggestion, blocked } = checked;
  const offer = suggestion && !dismissed;
  const original = checked.text;
  return (
    <section className="ask">
      <h1 className="list-title">
        {blocked ? "This needs a change before it can be asked" : results.length ? "Nobody has asked this yet, but check this first" : "Nobody has asked this yet"}
      </h1>
      {results.length ? <Marked checked={checked} /> : <p className="ask-text">{suggestion ?? original}</p>}
      {results.length > 0 && (
        <ol className="fix-list">
          {results.map((r, i) => (
            <li key={i} className={r.blocking ? "fix-must" : "fix-may"}>
              {r.reason}{!r.blocking && <span className="fix-tag"> Suggestion only.</span>}
            </li>
          ))}
        </ol>
      )}

      {offer && (
        <div className="did-you-mean" role="group" aria-label="Did you mean">
          <p className="dym-label">Did you mean:</p>
          <p className="ask-text dym-text">{suggestion}</p>
          <div className="dym-actions">
            {signedIn ? (
              <form action={askAction}>
                <input type="hidden" name="text" value={suggestion} />
                <input type="hidden" name="back" value={back} />
                <button className="btn solid">Yes, ask this</button>
              </form>
            ) : (
              <Link className="btn solid" href={searchFor(suggestion)}>Yes</Link>
            )}
            <Link className="btn" href={searchFor(original, "&keep=1")}>No</Link>
            <Link className="btn" href={searchFor(suggestion, "&edit=1")}>Edit</Link>
          </div>
        </div>
      )}

      {!offer && blocked && <p className="ask-note">Change your question in the search box above, then search again.</p>}

      {!offer && !blocked && (signedIn ? (
        <form action={askAction}>
          <input type="hidden" name="text" value={original} />
          <input type="hidden" name="back" value={back} />
          <button className="btn solid">Ask now</button>
          <span className="ask-note">Asked anonymously.{hasMatches && " Check the similar questions first."}</span>
        </form>
      ) : (
        <p className="q-join">
          <Link href={`/signup?next=${encodeURIComponent(back)}`}>Create an account</Link> to ask it.
        </p>
      ))}
    </section>
  );
}
