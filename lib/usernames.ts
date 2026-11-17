import { query } from "./db";

// Usernames are optional at signup. A blank one is filled with a generated name like
// "quiet_harbor42", which the person can change later in Settings → Security.

export const USERNAME_RULE = "Usernames are 3 to 20 letters, numbers or underscores.";
const RESERVED = /^(deleted|admin|moderator|support|beliefmap|beliefatlas)/;
// How often a username can change, so names can't be cycled to dodge reports.
export const RENAME_EVERY_HOURS = 24;

export function usernameProblem(name: string): string | null {
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return USERNAME_RULE;
  if (RESERVED.test(name)) return "That username is taken.";
  return null;
}

const ADJECTIVES = [
  "amber", "brave", "bright", "calm", "clever", "cosmic", "curious", "eager", "gentle", "golden",
  "honest", "humble", "jolly", "keen", "kind", "lucky", "mellow", "nimble", "noble", "patient",
  "polar", "quiet", "rapid", "silver", "steady", "sunny", "swift", "tidy", "vivid", "witty",
];
const NOUNS = [
  "acorn", "badger", "beacon", "bramble", "canyon", "comet", "falcon", "fern", "harbor", "heron",
  "island", "lantern", "maple", "meadow", "otter", "pebble", "pine", "quill", "raven", "river",
  "robin", "sparrow", "summit", "thistle", "tide", "willow", "wren", "zephyr", "orchard", "lark",
];

export function randomUsername(random: () => number = Math.random): string {
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  return `${pick(ADJECTIVES)}_${pick(NOUNS)}${Math.floor(random() * 1000)}`;
}

// A generated name nobody holds and no pending signup has claimed.
export async function generateUsername(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const name = randomUsername();
    const [row] = await query<{ taken: boolean }>(
      `select exists(select 1 from accounts where username = $1)
           or exists(select 1 from pending_signups where username = $1 and expires_at > now()) as taken`,
      [name],
    );
    if (!row.taken) return name;
  }
  // Practically unreachable with 900,000 combinations; fall back to a longer random suffix.
  return `member_${Math.floor(Math.random() * 1e9)}`.slice(0, 20);
}

export type RenameResult = { ok: true; username: string } | { ok: false; error: string };

export async function renameAccount(accountId: number, raw: string): Promise<RenameResult> {
  const username = raw.trim().toLowerCase();
  const problem = usernameProblem(username);
  if (problem) return { ok: false, error: problem };
  const [me] = await query<{ username: string; recent: boolean }>(
    `select username, coalesce(username_changed_at > now() - interval '${RENAME_EVERY_HOURS} hours', false) as recent
       from accounts where id = $1`,
    [accountId],
  );
  if (!me) return { ok: false, error: "That account wasn't found." };
  if (me.username === username) return { ok: true, username };
  if (me.recent) return { ok: false, error: "You can change your username once a day." };
  try {
    await query("update accounts set username = $2, username_changed_at = now() where id = $1", [accountId, username]);
    return { ok: true, username };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, error: "That username is taken." };
    throw err;
  }
}
