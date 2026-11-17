// A face scan with an ID document ("liveness and ID check") for the optional verified tier.
// It needs a paid vendor (Persona, Veriff, Yoti, Incode and similar charge per check), and
// paid services are on hold, so the only implementation is a disabled one. A vendor adapter
// implements this interface: start a hosted check, then take the vendor's signed result.
//
// What we would keep: that a check passed, when, which vendor and which method. Never the
// face images, the document images or the biometric template; those stay with the vendor
// under its retention terms.

export type IdentityCheckStart = { ok: true; redirectUrl: string; sessionId: string } | { ok: false; error: string };
export type IdentityCheckResult = { ok: true; passed: boolean; vendorReference: string } | { ok: false; error: string };

export interface IdentityVerifier {
  readonly name: string;
  readonly enabled: boolean;
  start(accountId: number, returnUrl: string): Promise<IdentityCheckStart>;
  // Called with the vendor's webhook body and signature header.
  handleResult(body: string, signature: string | null): Promise<IdentityCheckResult>;
}

export const disabledIdentityVerifier: IdentityVerifier = {
  name: "none",
  enabled: false,
  async start() {
    return { ok: false, error: "Face and ID checks aren't available yet." };
  },
  async handleResult() {
    return { ok: false, error: "Face and ID checks aren't available yet." };
  },
};

export function identityVerifier(): IdentityVerifier {
  return disabledIdentityVerifier;
}
