// Builds the BeliefAtlas Claude plugin into dist/claude-plugin/beliefatlas/ (belief-map/claude-plugin.md).
//
//   npm run plugin:build             uses PUBLIC_BASE_URL; refuses placeholders and localhost
//   npm run plugin:build -- --local  points at http://localhost:3000, for `claude --plugin-dir`
//
// It only writes files on this machine. It never uploads, publishes or submits the plugin
// anywhere: that waits for Sean's word and the real domain.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "integrations/claude-plugin/beliefatlas");
const OUT = join(process.cwd(), "dist/claude-plugin/beliefatlas");
const LOCAL = "http://localhost:3000";

export function pluginBase(env: NodeJS.ProcessEnv, local: boolean): { ok: true; base: string } | { ok: false; why: string } {
  if (local) return { ok: true, base: LOCAL };
  const raw = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return { ok: false, why: "PUBLIC_BASE_URL isn't set. The plugin needs the real domain (or use --local)." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: `PUBLIC_BASE_URL isn't a web address: ${raw}` };
  }
  if (url.protocol !== "https:") return { ok: false, why: "The plugin's address must be https." };
  const host = url.hostname;
  if (host === "localhost" || host.startsWith("127.") || host.endsWith(".local")) return { ok: false, why: "Use --local for a local address." };
  if (/example|placeholder|vercel\.app$/.test(host)) return { ok: false, why: `${host} is a placeholder or preview address, not the chosen domain.` };
  return { ok: true, base: url.origin };
}

export function mcpJson(base: string): string {
  const template = readFileSync(join(SRC, ".mcp.json.template"), "utf8");
  return template.replaceAll("{{BASE}}", base);
}

function main() {
  const local = process.argv.includes("--local");
  const picked = pluginBase(process.env, local);
  if (!picked.ok) {
    console.error(`Not built: ${picked.why}`);
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(SRC, OUT, { recursive: true, filter: (p) => !p.endsWith(".mcp.json.template") });
  writeFileSync(join(OUT, ".mcp.json"), mcpJson(picked.base));
  console.log(`Built ${OUT} for ${picked.base}${local ? " (local only)" : ""}. Not published anywhere.`);
}

if (process.argv[1]?.endsWith("build.ts")) main();
