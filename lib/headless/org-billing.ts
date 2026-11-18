import type Stripe from "stripe";
import { siteUrl, stripeClient } from "../billing";
import { query } from "../db";
import { logger } from "../log";
import { isProductionEnv } from "../provenance";
import { orgBillingEnabled } from "./config";
import type { Org, OrgRole } from "./orgs";
import { isPlanId, PLANS, type PlanId } from "./plans";

// Paid org plans (belief-map/headless-front-door.md section 10, decision 3). Built complete,
// switched off: HEADLESS_ORG_BILLING_ENABLED, Stripe itself (lib/billing.ts) and one Stripe
// price per paid plan (STRIPE_ORG_PRICE_PRO, STRIPE_ORG_PRICE_BUSINESS) must all be set.
// Stripe is the source of truth, as for membership: each webhook re-reads the subscription and
// sets the org's plan from its status and price.
//
// Outside production with Stripe not configured, a development mode sets the plan directly so
// the paid limits can be tried locally. A plan buys capacity, never data: every plan keeps the
// same consent, small-group, children and sanctions rules.

type Env = Record<string, string | undefined>;
export type OrgBillingMode = "stripe" | "dev" | "off";

export function orgBillingMode(env: Env = process.env): OrgBillingMode {
  if (!orgBillingEnabled(env)) return "off";
  const priced = (["pro", "business"] as const).every((p) => env[PLANS[p].priceEnv!]);
  if (stripeClient() && priced) return "stripe";
  return isProductionEnv(env) ? "off" : "dev";
}

function planForPrice(priceId: string | null | undefined, env: Env): PlanId | null {
  if (!priceId) return null;
  for (const p of ["pro", "business"] as const) if (env[PLANS[p].priceEnv!] === priceId) return p;
  return null;
}

type Admin = Org & { role: OrgRole };

export async function startOrgCheckout(org: Admin, plan: string, env: Env = process.env): Promise<{ url: string } | { error: string }> {
  const mode = orgBillingMode(env);
  if (mode === "off") return { error: "Paid plans aren't available yet." };
  if (org.role !== "admin") return { error: "Only an admin of this organization can change its plan." };
  if (!org.serving) return { error: "Plans open once the organization has been approved." };
  if (!isPlanId(plan) || plan === "free") return { error: "Choose a paid plan." };
  const back = `${siteUrl()}/org/${org.slug}`;
  if (mode === "dev") {
    await query("update organizations set plan = $2, plan_status = 'dev', plan_changed_at = now() where id = $1", [org.id, plan]);
    return { url: `/org/${org.slug}?saved=plan` };
  }
  const [row] = await query<{ stripe_customer_id: string | null }>("select stripe_customer_id from organizations where id = $1", [org.id]);
  const session = await stripeClient()!.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env[PLANS[plan].priceEnv!]!, quantity: 1 }],
    client_reference_id: `org:${org.id}`,
    customer: row?.stripe_customer_id ?? undefined,
    subscription_data: { metadata: { org_id: String(org.id) } },
    metadata: { org_id: String(org.id) },
    success_url: `${back}?saved=plan`,
    cancel_url: back,
  });
  return session.url ? { url: session.url } : { error: "Checkout didn't open. Try again." };
}

// Stripe's own page for the org's card, invoices, plan changes and cancelling.
export async function orgBillingPortal(org: Admin, env: Env = process.env): Promise<{ url: string } | { error: string }> {
  const mode = orgBillingMode(env);
  if (org.role !== "admin") return { error: "Only an admin of this organization can manage billing." };
  if (mode === "dev") {
    await query("update organizations set plan = 'free', plan_status = 'canceled', plan_changed_at = now() where id = $1", [org.id]);
    return { url: `/org/${org.slug}?saved=plan` };
  }
  if (mode === "off") return { error: "Billing isn't available." };
  const [row] = await query<{ stripe_customer_id: string | null }>("select stripe_customer_id from organizations where id = $1", [org.id]);
  if (!row?.stripe_customer_id) return { error: "There's no billing record for this organization yet." };
  const session = await stripeClient()!.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${siteUrl()}/org/${org.slug}` });
  return { url: session.url };
}

export const isOrgSubscription = (sub: { metadata?: Record<string, string> | null }) => Boolean(sub.metadata?.org_id);

// Called from lib/billing.ts handleWebhook for subscriptions whose metadata names an org.
export async function applyOrgSubscription(subscriptionId: string, env: Env = process.env): Promise<void> {
  const stripe = stripeClient();
  if (!stripe) return;
  const sub: Stripe.Subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const orgId = Number(sub.metadata?.org_id);
  if (!Number.isInteger(orgId) || orgId <= 0) return;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const plan = planForPrice(sub.items.data[0]?.price?.id, env);
  if (!plan) logger.warn("org subscription with a price that names no plan", { subscriptionId });
  const updated = await query(
    `update organizations set stripe_customer_id = $2, plan_status = $3, plan = coalesce($4, plan), plan_changed_at = now()
      where id = $1 returning id`,
    [orgId, customer, sub.status, plan],
  );
  if (!updated.length) logger.warn("stripe subscription for an unknown org", { subscriptionId });
}

// For tests and the dev mode: what a webhook would set, without Stripe.
export async function setOrgPlanStatus(orgId: number, plan: PlanId, status: string): Promise<void> {
  await query("update organizations set plan = $2, plan_status = $3, plan_changed_at = now() where id = $1", [orgId, plan, status]);
}
