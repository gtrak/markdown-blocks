/**
 * Markdown Blocks Server — thin orchestration layer (Bun runtime).
 * Delegates to config.ts, ast.ts, indexer.ts, inject.ts, save.ts modules.
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { Config } from "./types.js";

// --- Dynamic client compilation (bun build at startup) ---

/** Compile `client.ts` → JS using `bun build`. Cached once per server start. */
let compiledClient: Uint8Array | null = null;
let compiledClientError: Error | null = null;

function compileClientScript(): void {
  const pkgRoot = resolve(import.meta.dirname, "..");
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "build", "--target=browser", "--format=iife", "--no-bundle", "./src/client.ts"],
    cwd: pkgRoot,
  });
  if (proc.stdout && proc.stdout.length > 0) {
    compiledClient = proc.stdout;
  } else {
    const errText = new TextDecoder().decode(proc.stderr || new Uint8Array());
    compiledClientError = new Error(`Client compile failed: ${errText}`);
  }
}

// Compile at import time (not request time) so errors surface immediately.
try {
  compileClientScript();
} catch (e) {
  compiledClientError = e instanceof Error ? e : new Error(String(e));
}
import { Indexer } from "./indexer.js";
import { injectUneditableBanner, injectHtmxShells, injectHtmxClient } from "./inject.js";
import { handleSave, handleSource, corsHeaders } from "./save.js";
import { annotateAll, deannotateAll } from "./annotate.js";
import { parseBlocks } from "./ast.js";
import { deannotate } from "./annotate.js";

// Backward-compatible type for users who had inline config
export interface SaveServerConfig {
  contentDir: string;
  pathMap: Record<string, string>;
  backendProxyUrl?: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "host",
]);

// Main factory function — same API as before, now also accepts Config
export function createSaveHandler(
  raw: Config | SaveServerConfig,
): (req: Request) => Promise<Response> {
  // Normalize config: legacy SaveServerConfig → Config
  const cfg: Config = Object.assign({}, raw as Partial<Config>, {
    contentDir: (raw as Config).contentDir ?? "content",
    preset: ("preset" in raw ? (raw as Config).preset : "generic") as string,
    contentSelector: (raw as Config).contentSelector ?? "main",
  });

  // Crash recovery + fresh annotation
  try {
    deannotateAll(cfg.contentDir);
  } catch { /* already clean or dir missing */ }
  try {
    annotateAll(cfg.contentDir);
  } catch (e) {
    console.warn(`[markdown-blocks] Could not annotate content: ${e}`);
  }

  // Shutdown: clean up annotations
  const cleanup = () => {
    try { deannotateAll(cfg.contentDir); } catch {}
  };
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  // Initialize indexer and build immediately
  const indexer = new Indexer(cfg);
  try {
    indexer.build();
  } catch {
    console.warn(`[markdown-blocks] Could not build index for "${cfg.contentDir}"`);
  }
  indexer.watch(() => {
    // Rebuild index on file-system changes (silent, no-op callback)
  });

  // If no backend proxy, return a save-only handler
  if (!cfg.backendProxyUrl) {
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      // Serve client script — compiled from src/client.ts at startup via bun build
      if (url.pathname === "/mb-client.js") {
        if (!compiledClient) return new Response(compiledClientError?.message ?? "Client compile failed", { status: 500 });
        return new Response(compiledClient, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      }

      if (url.pathname === "/save" && req.method === "POST") {
        return handleSave(req, cfg, indexer);
      }
      if (url.pathname === "/source") {
        return handleSource(req, cfg, indexer);
      }
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      return new Response("Not found", { status: 404 });
    };
  }

  // Full handler with proxy support
  const proxyUrl = cfg.backendProxyUrl!;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Serve client script — compiled from src/client.ts at startup via bun build
    if (url.pathname === "/mb-client.js") {
      if (!compiledClient) return new Response(compiledClientError?.message ?? "Client compile failed", { status: 500 });
      return new Response(compiledClient, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    // Save endpoint
    if (url.pathname === "/save" && req.method === "POST") {
      return handleSave(req, cfg, indexer);
    }

    // Source endpoint (fetch raw markdown for a block)
    if (url.pathname === "/source") {
      return handleSource(req, cfg, indexer);
    }

    // Proxy to backend
    try {
      const proxiedHeaders: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) proxiedHeaders[k] = v;
      }
      proxiedHeaders["Connection"] = "close";

      const rawRes = await fetch(`${proxyUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: proxiedHeaders,
        body: req.method !== "GET" ? req.body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      } as RequestInit);

      // Non-200 or non-HTML → pass through unchanged
      const ct = rawRes.headers.get("content-type") || "";
      if (rawRes.status !== 200 || !ct.includes("text/html")) {
        return rawRes;
      }

      let html = await rawRes.text();

      // Strip Zola livereload script — htmx handles in-editor updates, so the
      // livereload websocket would only cause unwanted full-page reloads.
      html = html.replace(/<script\s+src="\/livereload\.js[^"]*"\s*>[\s\S]*?<\/script>/gi, "");

      const resolvedPath = indexer.resolve(url.pathname);

      // Just copy headers (strip content-length if body modified)
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of rawRes.headers.entries()) {
        resHeaders[k] = v;
      }

      if (resolvedPath) {
        // Source exists — parse blocks and inject htmx shells
        const src = fs.readFileSync(resolvedPath, "utf-8");
        const cleanSrc = deannotate(src);
        const blocks = parseBlocks(cleanSrc);

        html = injectHtmxShells(html, blocks, cfg.contentSelector || "main", url.pathname);
        delete resHeaders["content-length"];
      } else {
        // No source — inject uneditable banner
        html = injectUneditableBanner(html);
        delete resHeaders["content-length"];
      }

      // Always inject htmx client runtime (script + CSS + save indicator)
      html = injectHtmxClient(html);
      // content-length already deleted above, but body changed again
      delete resHeaders["content-length"];

      return new Response(html, {
        status: rawRes.status,
        headers: resHeaders,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[markdown-blocks] Proxy error: ${msg}`);
      return new Response("Backend unavailable", { status: 502 });
    }
  };
}
