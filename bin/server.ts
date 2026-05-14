#!/usr/bin/env -S bun run

/**
 * Markdown Blocks — Save Server CLI
 *
 * Usage:
 *   markdown-blocks-server --content-dir ./content --preset zola --proxy http://localhost:1112
 *   markdown-blocks-server --content-dir ./content --preset hugo --port 8765
 */

import { createSaveHandler } from "../src/server.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv: string[]): void {
  const cfg: {
    contentDir?: string;
    preset?: string;
    port?: number;
    backendProxyUrl?: string;
    pathMap?: Record<string, string>;
    pidDir?: string;
  } = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--content-dir" && i + 1 < argv.length) {
      cfg.contentDir = argv[++i];
    } else if (arg === "--preset" && i + 1 < argv.length) {
      cfg.preset = argv[++i];
    } else if (arg === "--port" && i + 1 < argv.length) {
      cfg.port = parseInt(argv[++i], 10);
    } else if (arg === "--proxy" && i + 1 < argv.length) {
      cfg.backendProxyUrl = argv[++i];
    } else if (arg === "--path-map" && i + 1 < argv.length) {
      try {
        cfg.pathMap = JSON.parse(argv[++i]);
      } catch {
        console.error("Invalid --path-map JSON:", argv[i]);
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: markdown-blocks-server [options]

Options:
  --content-dir <dir>   Path to markdown source files (required)
  --preset <name>       SSG preset: zola, hugo, jekyll, generic (default: generic)
  --port <n>            Save server port (default: 9999)
  --proxy <url>         Backend dev server URL to proxy
  --path-map <json>     JSON object mapping URL paths to filenames
  --pid-dir <dir>       Directory for PID file (default: /tmp/markdown-blocks-<port>)
  --help, -h            Show this help
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}. Use --help for usage.`);
      process.exit(1);
    }
    i++;
  }

  if (!cfg.contentDir) {
    console.error("Error: --content-dir is required. Use --help for usage.");
    process.exit(1);
  }

  const port = cfg.port ?? 9999;
  const preset = cfg.preset ?? "generic";
  // PID dir: explicit arg > env var > temp default
  const pidDir = cfg.pidDir
    ?? process.env.MARKDOWN_BLOCKS_PID_DIR
    ?? path.join(os.tmpdir(), `markdown-blocks-${port}`);

  console.log(`markdown-blocks save server on :${port} (preset: ${preset})`);

  // Write PID file for process management
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    const pidFile = path.join(pidDir, "site-save.pid");
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch {}

  const handler = createSaveHandler({
    contentDir: cfg.contentDir,
    preset,
    backendProxyUrl: cfg.backendProxyUrl,
    pathMap: cfg.pathMap,
  });

  Bun.serve({ port, hostname: "0.0.0.0", fetch: handler });

  function cleanup() {
    try { fs.unlinkSync(path.join(pidDir, "site-save.pid")); } catch {}
  }
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
}

parseArgs(Bun.argv.slice(2));
