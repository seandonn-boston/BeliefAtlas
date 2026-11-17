import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

// Encryption at rest for small secrets the server has to read back, such as authenticator-app
// secrets. The key is derived from PHONE_PEPPER, the server's existing secret, so there is no
// new key to manage; changing the pepper makes these unreadable (as it already orphans
// accounts), so it is never changed.

function key(purpose: string): Buffer {
  const pepper = process.env.PHONE_PEPPER;
  if (!pepper) throw new Error("PHONE_PEPPER is not set");
  return Buffer.from(hkdfSync("sha256", pepper, "belief-map", purpose, 32));
}

export function seal(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function open(sealed: string, purpose: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
