// The adult check at signup. A date of birth comes in, a yes or no goes out; the date itself
// is never stored.

export const ADULT_AGE = 18;
export const AGE_GATE_COOKIE = "bm_age_gate";
// After a date that is under 18, this browser can't try another date for a day, so the gate
// can't be passed by stepping the year back until it works.
export const AGE_GATE_HOURS = 24;

export type AgeMethod = "dob" | "digital_credential" | "declared_age_range" | "play_age_signals";

export type Ymd = { year: number; month: number; day: number };

// Accepts the YYYY-MM-DD that <input type="date"> submits. Returns null for anything that is
// not a real calendar date.
export function parseDob(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

// The earliest calendar date anywhere on Earth right now (UTC-12). Checking against it means
// nobody counts as 18 before their 18th birthday has started where they live.
export function earliestToday(now: Date = new Date()): Ymd {
  const d = new Date(now.getTime() - 12 * 3600 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Whole years between the two dates. Someone born on 29 February has a birthday on 1 March
// in years that have no 29 February, which is the later of the two common conventions.
export function ageOn(dob: Ymd, today: Ymd): number {
  let age = today.year - dob.year;
  const leapless = dob.month === 2 && dob.day === 29 && !isLeap(today.year);
  const birthdayMonth = leapless ? 3 : dob.month;
  const birthdayDay = leapless ? 1 : dob.day;
  if (today.month < birthdayMonth || (today.month === birthdayMonth && today.day < birthdayDay)) age -= 1;
  return age;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export type AgeCheck = { ok: true } | { ok: false; underage: boolean; error: string };

export function checkAdult(value: string, now: Date = new Date()): AgeCheck {
  const dob = parseDob(value);
  if (!dob) return { ok: false, underage: false, error: "Enter your date of birth." };
  const age = ageOn(dob, earliestToday(now));
  if (age < 0) return { ok: false, underage: false, error: "That date of birth is in the future." };
  if (age > 120) return { ok: false, underage: false, error: "Check the year of your date of birth." };
  if (age < ADULT_AGE) return { ok: false, underage: true, error: "Sorry, you need to be 18 or older to create an account." };
  return { ok: true };
}
