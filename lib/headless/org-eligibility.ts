// Which organizations may use the front door at all (Sean, 17 Nov): none based in a sanctioned
// place, none in Russia, Belarus or China, and every org screened against the US, UN, EU and UK
// sanctions lists before it is approved. There is no exemption.
//
// The country list here is a stand-in. The shared list of blocked places and the screening job
// belong to develop (the region block); when this branch merges, blockedOrgCountry() reads that
// list and this set goes. Screening sets organizations.sanctions_cleared_at; a match leaves it
// null, so the org never serves.

// ISO 3166-1 alpha-2. Russia, Belarus and China by Sean's call; the others are under comprehensive US
// embargoes. Region-level sanctions (Crimea, Donetsk, Luhansk and others) need the region block's
// finer list, since a country code can't express them.
const STAND_IN_BLOCKED = new Set(["RU", "BY", "CN", "CU", "IR", "KP"]);

export const isCountryCode = (raw: unknown): raw is string => typeof raw === "string" && /^[A-Z]{2}$/.test(raw);

export function blockedOrgCountry(country: string | null | undefined): boolean {
  // No country on file reads as blocked: an org can't serve until we know where it is.
  if (!isCountryCode(country)) return true;
  return STAND_IN_BLOCKED.has(country);
}

export type OrgEligibility = { country: string | null; sanctionsClearedAt: Date | null };

// Both must hold for any of an org's placements to serve.
export const orgEligible = (o: OrgEligibility) => !blockedOrgCountry(o.country) && o.sanctionsClearedAt !== null;
