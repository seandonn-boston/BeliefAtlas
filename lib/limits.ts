import { previewTestMode } from "./preview";
// Daily allowances per tier. A "day" is a UTC calendar day.
// Everyone, on every tier, gets one change per question per day.
export type Tier = "free" | "paid";

export const LIMITS: Record<Tier, {
  votesPerDay: number;
  questionsPerDay: number;
  privateRecastsPerDay: number;
  publicToPrivatePerDay: number;
}> = {
  free: { votesPerDay: 100, questionsPerDay: 10, privateRecastsPerDay: 10, publicToPrivatePerDay: 10 },
  paid: {
    votesPerDay: Infinity,
    questionsPerDay: Infinity,
    privateRecastsPerDay: Infinity,
    publicToPrivatePerDay: Infinity,
  },
};

// Breakdowns are withheld for groups smaller than this. 50 by default, the same as the default
// region's minimum (regions table); MIN_GROUP_SIZE overrides it, and a preview in test mode
// uses 5 so its small demo data still shows something.
export const MIN_GROUP_SIZE = Number(process.env.MIN_GROUP_SIZE ?? (previewTestMode ? 5 : 50));

// SQL fragment: "this timestamp column falls on today's UTC date".
export const TODAY_UTC = (col: string) =>
  `(${col} at time zone 'utc')::date = (now() at time zone 'utc')::date`;
