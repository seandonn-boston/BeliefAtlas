// Preview test mode: lets a Vercel preview deployment be tried end to end without Twilio or
// Stripe. Signup codes are fixed and shown on the page, membership switches without payment,
// and the build loads the catalog and the demo votes.
//
// It needs both PREVIEW_TEST_MODE=1 and Vercel's own VERCEL_ENV=preview, so it can never
// switch on in production even if the variable is set there by mistake.
export const previewTestMode = process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_TEST_MODE === "1";

// The signup code in preview test mode.
export const PREVIEW_SMS_CODE = process.env.SMS_DEV_CODE || "000000";
