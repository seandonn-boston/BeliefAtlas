import { test } from "node:test";
import assert from "node:assert/strict";
import { baseUrl } from "../lib/front-door";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

test("site address: set value wins, a preview uses its own branch address, production never does", () => {
  assert.equal(baseUrl(env({ PUBLIC_BASE_URL: "https://example.com/" })), "https://example.com");
  assert.equal(baseUrl(env({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "beliefatlas-git-x.vercel.app", VERCEL_URL: "beliefatlas-abc.vercel.app" })), "https://beliefatlas-git-x.vercel.app");
  assert.equal(baseUrl(env({ VERCEL_ENV: "preview", VERCEL_URL: "beliefatlas-abc.vercel.app" })), "https://beliefatlas-abc.vercel.app");
  assert.equal(baseUrl(env({ VERCEL_ENV: "production", VERCEL_URL: "beliefatlas-abc.vercel.app" })), "http://localhost:3000");
});
