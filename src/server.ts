/**
 * Markdown Blocks Server — thin orchestration layer (Bun runtime).
 * Delegates to config.ts, ast.ts, indexer.ts, inject.ts, save.ts modules.
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { Config } from "./types.js";

// --- Lazy async client compilation (bun build on first request) ---

let clientCompilationPromise: Promise<Uint8Array> | null = null;

async function getClientScript(): Promise<Uint8Array> {
  if (clientCompilationPromise) return clientCompilationPromise;

  clientCompilationPromise = (async () => {
    const pkgRoot = resolve(import.meta.dirname, "..");
    const proc = Bun.spawn({
      cmd: [process.execPath, "build", "--target=browser", "--format=iife", "--no-bundle", "./src/client.ts"],
      cwd: pkgRoot,
    });

    // Await exit and stdout/stderr in parallel
    const [exitCode, stdoutBuffer] = await Promise.all([
      proc.exited,
      Bun.readableStreamToArrayBuffer(proc.stdout!),
    ]);

    if (exitCode !== 0) {
      const errText = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stderr!));
      throw new Error(`Client compile failed: ${errText}`);
    }

    return new Uint8Array(stdoutBuffer);
  })();

  return clientCompilationPromise;
}
import { Indexer } from "./indexer.js";
import { injectUneditableBanner, injectHtmxShells, injectHtmxClient } from "./inject.js";
import { handleSave, handleSource, corsHeaders } from "./save.js";
import { annotateAll, deannotateAll } from "./annotate.js";
import { parseBlocks } from "./ast.js";
import { deannotate } from "./annotate.js";


const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "host",
]);

/** Build a proxied Response, filtering hop-by-hop headers. */
function buildProxyResponse(modifiedHtml: string, rawRes: Response): Response {
  const headers = new Headers();
  for (const [k, v] of rawRes.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  return new Response(modifiedHtml, { status: rawRes.status, headers });
}

// Main factory function — accepts Config, returns handler and cleanup
export function createSaveHandler(
  cfg: Config,
): { handler: (req: Request) => Promise<Response>; cleanup: () => void } {

  // Crash recovery + fresh annotation
  try {
    deannotateAll(cfg.contentDir);
  } catch { /* already clean or dir missing */ }
  try {
    annotateAll(cfg.contentDir);
  } catch (e) {
    console.warn(`[markdown-blocks] Could not annotate content: ${e}`);
  }

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

  // Shared request handler
  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Serve client script — lazily compiled from src/client.ts via bun build
    if (url.pathname === "/mb-client.js") {
      try {
        const script = await getClientScript();
        return new Response(script, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(msg, { status: 500 });
      }
    }

    // Serve vendored HTMX when htmxSource is "bundled"
    if (url.pathname === "/htmx.min.js") {
      try {
        const htmxPath = new URL("htmx.org/dist/htmx.min.js", import.meta.resolve("htmx.org")).pathname;
        return new Response(fs.readFileSync(htmxPath), {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      } catch {
        return new Response("HTMX not available locally. Install htmx.org or use htmxSource: 'cdn'.", { status: 503 });
      }
    }

    // Save endpoint
    if (url.pathname === "/save" && req.method === "POST") {
      return handleSave(req, cfg, indexer);
    }

    // Source endpoint (fetch raw markdown for a block)
    if (url.pathname === "/source") {
      return handleSource(req, cfg, indexer);
    }

    // Proxy mode: forward to backend and inject htmx shells
    if (cfg.backendProxyUrl) {
      try {
        const proxiedHeaders: Record<string, string> = {};
        for (const [k, v] of req.headers.entries()) {
          if (!HOP_BY_HOP.has(k.toLowerCase())) proxiedHeaders[k] = v;
        }
        proxiedHeaders["Connection"] = "close";

        const rawRes = await fetch(`${cfg.backendProxyUrl}${url.pathname}${url.search}`, {
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

        if (resolvedPath) {
          // Source exists — parse blocks and inject htmx shells
          const src = fs.readFileSync(resolvedPath, "utf-8");
          const cleanSrc = deannotate(src);
          const blocks = parseBlocks(cleanSrc);

          html = injectHtmxShells(html, blocks, cfg.contentSelector || "main", url.pathname);
        } else {
          // No source — inject uneditable banner
          html = injectUneditableBanner(html);
        }

        // Always inject htmx client runtime (script + CSS + save indicator)
        html = injectHtmxClient(html, cfg.htmxSource ?? "cdn");

        return buildProxyResponse(html, rawRes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[markdown-blocks] Proxy error: ${msg}`);
        return new Response("Backend unavailable", { status: 502 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  // Cleanup function — called by CLI on shutdown, NOT registered to signals here
  const cleanup = () => {
    try { deannotateAll(cfg.contentDir); } catch {}
    indexer.stopWatch();
  };

  return { handler, cleanup };
}
