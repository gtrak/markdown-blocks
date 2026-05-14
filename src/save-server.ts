/**
 * Markdown Blocks Save Server — configurable entry point.
 *
 * Environment variables (all optional):
 *   MB_CONTENT_DIR     — content directory (default: "content")
 *   MB_BACKEND_URL     — upstream SSG proxy URL (e.g. "http://localhost:1112")
 *   MB_PORT            — listen port (default: 9999)
 *   MB_PATH_MAP        — JSON string or path to .json file with pathMap
 *   MB_PRESET          — preset name (default: "generic")
 */

import { createSaveHandler, type SaveServerConfig } from "./server.js";
import fs from "node:fs";
import path from "node:path";
import { pid } from "node:process";

// ---------------------------------------------------------------------------
// Config resolution with env var fallbacks
// ---------------------------------------------------------------------------

function resolvePathMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;

  // Try parsing as JSON directly first
  try {
    return JSON.parse(raw);
  } catch {}

  // Try reading as file path
  try {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    return JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch {}

  return undefined;
}

const config: SaveServerConfig = {
  contentDir: process.env.MB_CONTENT_DIR ?? "content",
  pathMap: resolvePathMap(process.env.MB_PATH_MAP),
  backendProxyUrl: process.env.MB_BACKEND_URL,
};

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const handler = createSaveHandler(config);
const port = parseInt(process.env.MB_PORT ?? "9999", 10);

console.log(
  config.backendProxyUrl
    ? `Markdown blocks save server on :${port} (proxying backend at ${config.backendProxyUrl})`
    : `Markdown blocks save server on :${port} (save-only mode)`,
);

const pidFile = process.env.MB_PID_FILE ?? ".slop/site-save.pid";
try {
  fs.writeFileSync(pidFile, pid.toString());
} catch { /* pid dir may not exist */ }

function cleanup() {
  try { fs.unlinkSync(pidFile); } catch {}
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });

Bun.serve({ port, hostname: "0.0.0.0", fetch: handler });
