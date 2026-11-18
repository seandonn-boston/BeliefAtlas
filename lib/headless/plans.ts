import type { Rule } from "../rate-limit";

// Org plans. The limits are placeholders until Sean sets them and the prices (decision 3 in
// belief-map/headless-front-door.md); prices live in Stripe, never here. Every plan gets the
// same rules on consent, small groups, children and sanctions: a plan buys capacity, never data.

export const PLAN_IDS = ["free", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type Plan = {
  id: PlanId;
  placements: number;   // placements not switched off
  members: number;      // people in the org, admins included
  keys: number;         // server keys not revoked
  relay: boolean;       // may send taps from its server (when the relay is switched on at all)
  relayPerMinute: number;
  priceEnv: string | null; // the env var naming this plan's Stripe price; null for free
};

export const PLANS: Record<PlanId, Plan> = {
  free:     { id: "free",     placements: 3,   members: 3,  keys: 1,  relay: false, relayPerMinute: 0,    priceEnv: null },
  pro:      { id: "pro",      placements: 25,  members: 10, keys: 5,  relay: true,  relayPerMinute: 600,  priceEnv: "STRIPE_ORG_PRICE_PRO" },
  business: { id: "business", placements: 200, members: 50, keys: 20, relay: true,  relayPerMinute: 3000, priceEnv: "STRIPE_ORG_PRICE_BUSINESS" },
};

export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);

// Stripe statuses that keep a paid plan's capacity. past_due covers Stripe's retry window.
const PAYING = new Set(["active", "trialing", "past_due", "dev", "manual"]);

// The plan an org can use right now: its paid plan while paying, otherwise free.
export function effectivePlan(plan: string, planStatus: string | null): Plan {
  if (!isPlanId(plan) || plan === "free") return PLANS.free;
  return planStatus && PAYING.has(planStatus) ? PLANS[plan] : PLANS.free;
}

export const relayRule = (plan: Plan): Rule => ({ name: `hl-relay-${plan.id}`, limit: plan.relayPerMinute, windowSeconds: 60 });
