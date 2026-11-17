// The one shape every question check returns, so a single "Did you mean" box can show any of
// them, and a new check (grammar from LanguageTool, a meaning-based duplicate search, a content
// sweep) plugs in without new screens. Sean's rule: whenever someone has to change their
// question, say why, show where, and offer a fix.

export type CheckCode =
  | "link"             // a web address, written out or disguised
  | "personal_data"    // an email address, phone number, handle or street address
  | "too_short"
  | "too_long"
  | "not_true_false"   // can't be answered true or false as written
  | "spelling"
  | "repeated_word"
  | "lowercase_i";

export type CheckResult = {
  code: CheckCode;
  // Must be fixed before the question can be posted. Grammar and spelling never block: the
  // asker can always say No and post what they wrote.
  blocking: boolean;
  reason: string;                                   // why, in plain words
  span: { start: number; end: number } | null;      // where, as offsets into CheckedQuestion.text
  fix: string | null;                               // what this one part should become ("" = remove it)
  // The stretch the fix replaces when it is wider than what's highlighted, e.g. removing a link
  // also removes the "at" in front of it. Defaults to span.
  replace?: { start: number; end: number };
};

export type CheckedQuestion = {
  text: string;               // what they typed, with whitespace collapsed; spans point into this
  results: CheckResult[];
  blocked: boolean;           // any result blocks posting
  suggestion: string | null;  // the whole question with every fix applied, or null if none applies
};
