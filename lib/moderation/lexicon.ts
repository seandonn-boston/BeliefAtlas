// Word lists for the sweep (./sweep.ts). Kept apart so they can grow without touching the
// logic, and short on purpose: every entry here can deny a question, so an entry that also has
// an innocent meaning ("chink in the armour", "Moby Dick", "pussy willow") is left out, and the
// moderator queue and reports catch what the lists miss.
//
// Words are matched loosely: repeated letters ("fuuuck"), look-alike characters ("sh1t",
// "f*ck") and dots or dashes between letters ("f.u.c.k") all count.

const LOOK: Record<string, string> = {
  a: "a@4*", e: "e3*", i: "i1!|*", o: "o0*", u: "uv*", s: "s5$", t: "t7", g: "g9", l: "l1", b: "b8",
};

// One word, matched loosely, as a regex source with no flags. `suffix` is plain regex.
export function loose(word: string, suffix = ""): string {
  const letters = [...word.toLowerCase()].map((ch) => {
    if (ch === " ") return "\\s+";
    if (ch === "-") return "[-\\s]?";
    const set = LOOK[ch] ?? ch;
    return `[${set}]+`;
  });
  return `(?<![\\p{L}\\p{N}])${letters.join("[*._-]?")}${suffix}(?![\\p{L}])`;
}

// Swearing: an ordinary denial with a milder word offered. `fix` is what to put instead
// ("" = remove it).
export type Swear = { word: string; suffix?: string; fix: (matched: string) => string };
const ING = /in[g']?$/i;
export const SWEARS: Swear[] = [
  { word: "motherfuck", suffix: "(?:er|ers|ing|in)", fix: () => "" },
  { word: "fuck", suffix: "(?:ing|in|ed|er|ers|s|face|wit)?", fix: (m) => (ING.test(m) ? "really" : "") },
  { word: "bullshit", suffix: "(?:ting)?", fix: () => "nonsense" },
  { word: "shit", suffix: "(?:ty|tier|tiest|s|ting|head|show)?", fix: (m) => (/show$/i.test(m) ? "mess" : /t(y|ier|iest)$/i.test(m) ? "bad" : "stuff") },
  { word: "asshole", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "dickhead", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "bastard", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "wanker", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "twat", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "cunt", suffix: "s?", fix: (m) => (/s$/i.test(m) ? "jerks" : "jerk") },
  { word: "bitch", suffix: "(?:es|y|ing)?", fix: (m) => (/ing$/i.test(m) ? "complaining" : /y$/i.test(m) ? "rude" : /es$/i.test(m) ? "jerks" : "jerk") },
];

// Slurs: a harmful denial. The fix removes the word; the reason asks for the group's own name.
export const SLURS: { word: string; suffix?: string }[] = [
  { word: "nigger", suffix: "s?" },
  { word: "nigga", suffix: "s?" },
  { word: "faggot", suffix: "s?" },
  { word: "kike", suffix: "s?" },
  { word: "spic", suffix: "s?" },
  { word: "wetback", suffix: "s?" },
  { word: "raghead", suffix: "s?" },
  { word: "towelhead", suffix: "s?" },
  { word: "gook", suffix: "s?" },
  { word: "tranny", suffix: "" },
  { word: "trannies", suffix: "" },
  { word: "retard", suffix: "(?:s|ed)?" },
  { word: "dyke", suffix: "s?" },
];

// Insults that degrade a person. Aimed at a named private person, a harmful denial.
export const DEGRADING = ["slut", "whore", "skank", "cunt", "bitch", "retard", "hoe"];

// Insults and accusations. Aimed at a named person not known to be public, the question is held
// for a moderator; joined to a personal detail (an address, a phone number) it is a harmful
// denial for targeting a private person.
export const ACCUSATIONS = [
  ...DEGRADING, "liar", "cheat", "cheater", "cheating", "cheats", "thief", "steals", "scammer", "scam artist", "fraud",
  "criminal", "abuser", "abusive", "pedophile", "paedophile", "predator", "rapist", "murderer", "drunk", "alcoholic",
  "junkie", "idiot", "moron", "stupid", "loser", "ugly", "fat", "creep", "creepy", "pervert", "psycho", "crazy",
  "worthless", "pathetic", "dumb", "lazy", "disgusting", "affair", "sleeping around",
];

// Groups of people. Used only together with the words below, never alone.
const GROUP_WORDS = [
  "immigrants", "migrants", "refugees", "foreigners", "muslims", "jews", "christians", "hindus", "sikhs", "buddhists",
  "atheists", "catholics", "mormons", "blacks", "whites", "asians", "latinos", "latinas", "hispanics", "mexicans",
  "arabs", "africans", "chinese", "indians", "gays", "lesbians", "homosexuals", "bisexuals", "gypsies", "roma",
  "women", "men", "jewish people", "muslim people", "black people", "white people", "asian people", "gay people",
  "trans people", "transgender people", "disabled people", "autistic people", "poor people", "old people",
];
export const GROUP = `(?:the\\s+)?(?:${GROUP_WORDS.map((g) => g.replace(/ /g, "\\s+")).join("|")})`;

// Calling a group less than human: a harmful denial when said of a group outright.
export const DEHUMANISING = `(?:vermin|sub-?humans?|savages|cockroaches|parasites|scum|filth|animals|rats|a\\s+disease|a\\s+plague|a\\s+cancer|an\\s+infestation|less\\s+than\\s+human|not\\s+(?:really\\s+|fully\\s+)?human)`;
// The strongest of those, which hold a question for review wherever they appear with a group.
export const DEHUMANISING_STRONG = `(?:vermin|sub-?humans?|cockroaches|less\\s+than\\s+human|an\\s+infestation)`;
// Sweeping put-downs of a group: held for a moderator, since a question can fairly ask about a
// stereotype, but it needs a person to look.
export const NEGATIVE = `(?:inferior|evil|stupid|criminals|dangerous|lazy|dirty|terrorists|rapists|violent|greedy|worthless|a\\s+threat)`;
export const VIOLENCE = `(?:die|be\\s+(?:killed|exterminated|wiped\\s+out|gassed|shot|hanged|lynched|eliminated|eradicated|executed))`;
export const VIOLENT_ACT = `(?:kill|exterminate|gas|shoot|lynch|hang|eradicate|eliminate|wipe\\s+out)`;

// Advertising. Each pattern on its own is enough; plain words like "discount" are not.
export const SPAM_PATTERNS: RegExp[] = [
  /\b(?:buy|order|shop|sign\s+up|register|join)\s+now\b/giu,
  /\bclick\s+(?:here|the\s+link|below|my\s+link|on\s+my\s+profile)\b/giu,
  /\buse\s+(?:my\s+|the\s+|promo\s+|discount\s+|coupon\s+)?code\s+[A-Za-z0-9]{3,}\b/giu,
  /\b(?:dm|message|text|call|whatsapp|telegram)\s+me\b/giu,
  /\bfollow\s+(?:me|us|my\s+\w+)\s+(?:on|at)\b/giu,
  /\bsubscribe\s+to\s+(?:my|our)\b/giu,
  /\bcheck\s+out\s+my\s+(?:channel|page|profile|shop|store|onlyfans|stream|podcast)\b/giu,
  /\blimited[-\s]time\s+(?:offer|deal|only)\b/giu,
  /\bfree\s+(?:money|followers|likes|gift\s+cards?|iphones?|v-?bucks|robux|crypto)\b/giu,
  /\b(?:earn|make)\s+\$?\d[\d,]*\s*(?:dollars\s+)?(?:a|per|every)\s+(?:day|week|hour|month)\b/giu,
  /\b(?:crypto|bitcoin|nft)\s+(?:giveaway|airdrop|signals)\b/giu,
  /\b(?:best|cheapest)\s+prices?\s+(?:on|for|at)\s+\w+/giu,
  /([!?$])\1{4,}/gu,
];

// About the asker's own life ("my boss"): nobody else can answer it. An ordinary denial. Only
// "my": "our family" or "our children" usually means everyone's.
const RELATIONS = [
  "boss", "manager", "supervisor", "neighbor", "neighbour", "neighbors", "neighbours", "coworker", "co-worker",
  "coworkers", "colleague", "colleagues", "roommate", "roommates", "flatmate", "landlord", "landlady", "tenant",
  "ex", "ex-wife", "ex-husband", "ex-girlfriend", "ex-boyfriend", "girlfriend", "boyfriend", "wife", "husband",
  "partner", "fiance", "fiancé", "fiancee", "fiancée", "teacher", "professor", "friend", "best friend", "friends",
  "sister", "brother", "mom", "mum", "dad", "mother", "father", "son", "daughter", "cousin", "aunt", "uncle",
  "grandma", "grandpa", "grandmother", "grandfather", "classmate", "classmates", "crush", "date", "kid", "kids",
  "child", "children", "baby", "family", "parents", "in-laws", "stepdad", "stepmom", "therapist", "doctor", "dentist",
];
export const MY_RELATION = new RegExp(
  `(?<![\\p{L}])(my)\\s+(?:own\\s+)?(${[...RELATIONS].sort((a, b) => b.length - a.length).map((r) => r.replace(/[-\s]/g, "[-\\s]?")).join("|")})(?![\\p{L}])`,
  "giu",
);
// "Am I ...", "Should I ...": about the asker. Each opener with what it becomes for everyone.
export const SELF_OPENERS: Record<string, string> = {
  "am i": "are people", "was i": "were people", "should i": "should people", "do i": "do people", "did i": "did people",
  "will i": "will people", "would i": "would people", "can i": "can people", "could i": "could people",
  "have i": "have people", "had i": "had people", "must i": "must people", "may i": "may people",
};
