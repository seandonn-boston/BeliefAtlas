import { randomBytes } from "crypto";
import { cookies } from "next/headers";

// A random id kept in a first-party cookie, so limits can count per browser as well as per IP
// address (many people share one IP on campus and mobile networks; one browser rarely holds
// many accounts). It identifies the browser, not the person, and is never sent anywhere.

export const DEVICE_COOKIE = "bm_device";

export async function deviceId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(DEVICE_COOKIE)?.value;
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const id = randomBytes(18).toString("base64url");
  jar.set(DEVICE_COOKIE, id, {
    path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24 * 400,
  });
  return id;
}
