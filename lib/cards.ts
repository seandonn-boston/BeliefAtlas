import { present, type Shown } from "./access";
import type { Tier } from "./limits";
import type { MyVote, Source } from "./votes";

// Everything a question card needs, already filtered for the viewer. This is what the feed
// API sends to the browser, so nothing the viewer may not see is ever in it.
export type CardItem = {
  id: number;
  text: string;
  status: string;
  category: string;
  slot: Source;
  shown: Shown;
  myVote: MyVote | null;
  fresh?: boolean;   // just voted on: animate the split in
  lang?: string;     // W3: the language `text` is in, for the card's `lang` attribute
  approved?: boolean; // M1: the "moderator approved" mark
};

type Row = {
  id: number; text: string; status: string; category: string; t: number; f: number; u: number; slot?: Source;
  lang?: string;     // W3: set when the row has been through localizeQuestions
  approved?: boolean; // M1
};

export function toCard(row: Row, account: { tier: Tier } | null, myVote: MyVote | null = null): CardItem {
  const tally = { true: row.t, false: row.f, unsure: row.u, total: row.t + row.f + row.u };
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    category: row.category,
    slot: row.slot ?? "direct",
    shown: present(tally, { account, voted: Boolean(myVote), closed: row.status !== "active" }),
    myVote,
    ...(row.lang ? { lang: row.lang } : {}), // W3
    ...(row.approved ? { approved: true } : {}), // M1
  };
}
