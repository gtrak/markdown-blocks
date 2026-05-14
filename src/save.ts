import path from "node:path";
import { Config, parseBlockId, formatBlockId } from "./types.js";
import { parseBlocks } from "./ast.js";
import { deannotate } from "./annotate.js";
import { Indexer } from "./indexer.js";
import { MarkdownService } from "./markdown-service.js";
import { buildHtmxShell, buildHtmxContentInner } from "./inject.js";
import { renderBlock, escapeHtml } from "./render.js";

// --- HTTP helpers ---

/** Standard CORS headers */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** Create a JSON Response with status and CORS headers */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

/** Create an HTML Response with CORS headers */
function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders(), "Content-Type": "text/html; charset=utf-8" },
  });
}

// --- Save body type (re-exported for consumers) ---
export type { SaveBody } from "./markdown-service.js";

// --- Parse form body for htmx requests ---

async function parseHtmxBody(req: Request): Promise<SaveBody> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return formParamsToSaveBody(params);
  }
  if (ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    return {
      action: (fd.get("action") as SaveBody["action"]) || undefined,
      blockId: (fd.get("blockId") as string) || undefined,
      afterBlockId: (fd.get("afterBlockId") as string) || undefined,
      beforeBlockId: (fd.get("beforeBlockId") as string) || undefined,
      tag: (fd.get("tag") as string) || undefined,
      text: (fd.get("text") as string) || undefined,
      direction: (fd.get("direction") as SaveBody["direction"]) || undefined,
      path: (fd.get("path") as string) || undefined,
      filepath: (fd.get("filepath") as string) || undefined,
    };
  }
  return req.json() as Promise<SaveBody>;
}

function formParamsToSaveBody(params: URLSearchParams): SaveBody {
  return {
    action: (params.get("action") as SaveBody["action"]) || undefined,
    blockId: params.get("blockId") || undefined,
    afterBlockId: params.get("afterBlockId") || undefined,
    beforeBlockId: params.get("beforeBlockId") || undefined,
    tag: params.get("tag") || undefined,
    text: params.get("text") || undefined,
    direction: (params.get("direction") as SaveBody["direction"]) || undefined,
    path: params.get("path") || undefined,
    filepath: params.get("filepath") || undefined,
  };
}

// --- Main save handler ---

/**
 * Fetch-compatible save handler. Delegates file I/O and AST mutations to
 * MarkdownService; handles only HTTP concerns (parsing, response formatting).
 */
export async function handleSave(
  req: Request,
  config: Config,
  indexer: Indexer
): Promise<Response> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  const isHtmx = req.headers.get("HX-Request") === "true";

  let body: SaveBody;
  try {
    if (isHtmx) {
      body = await parseHtmxBody(req);
    } else {
      body = await req.json();
    }
  } catch {
    return jsonResponse(400, { ok: false, msg: "Invalid body" });
  }

  const action = body.action || "edit";
  const service = new MarkdownService(config, indexer);

  // --- Resolve filepath via service ---
  const fileResult = service.resolveFile(body);
  if ("error" in fileResult) {
    return jsonResponse(fileResult.error.status, { ok: false, msg: fileResult.error.msg });
  }
  const filepath = fileResult.filepath;

  // --- Read source file via service ---
  const readResult = service.readDeannotated(filepath);
  if ("error" in readResult) {
    return jsonResponse(readResult.error.status, { ok: false, msg: readResult.error.msg });
  }

  const cleanContent = readResult.content;
  let newText = body.text ?? "";

  // --- Route mutation by action ---
  let mutationResult: { result: string; success?: boolean };

  if (action === "edit") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const r = service.edit(cleanContent, body.blockId, newText);
    if ("error" in r) return jsonResponse(r.error.status, { ok: false, msg: r.error.msg });
    mutationResult = r;
  } else if (action === "delete") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const r = service.del(cleanContent, body.blockId);
    if ("error" in r) return jsonResponse(r.error.status, { ok: false, msg: r.error.msg });
    mutationResult = r;
  } else if (action === "insert") {
    if (!body.afterBlockId) return jsonResponse(400, { ok: false, msg: "Missing afterBlockId" });
    if (!body.tag) return jsonResponse(400, { ok: false, msg: "Missing tag" });
    const r2 = service.insert(cleanContent, body.afterBlockId, body.tag, newText);
    if ("error" in r2) return jsonResponse(r2.error.status, { ok: false, msg: r2.error.msg });
    mutationResult = r2;
  } else if (action === "move") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const r3 = service.move(cleanContent, body.blockId, body.direction || undefined, body.beforeBlockId || undefined);
    if ("error" in r3) return jsonResponse(r3.error.status, { ok: false, msg: r3.error.msg });
    mutationResult = r3;
  } else {
    return jsonResponse(400, { ok: false, msg: "Unknown action" });
  }

  if (!mutationResult.success) {
    return jsonResponse(400, { ok: false, msg: `${action} failed: block not found` });
  }

  // --- Atomic write via service ---
  const writeResult = service.mutateAndWrite(filepath, cleanContent, mutationResult.result);
  if ("error" in writeResult) {
    return jsonResponse(writeResult.error.status, { ok: false, msg: writeResult.error.msg });
  }

  // --- HTMX response formatting (presentation concern — stays in controller) ---
  if (isHtmx) {
    const newClean = deannotate(writeResult.annotated);

    if (action === "move") {
      return jsonResponse(200, { ok: true });
    }

    if (action === "delete") {
      return htmlResponse(200, "");
    }

    // insert: compose and render the new block
    if (action === "insert") {
      const afterParsed = parseBlockId(body.afterBlockId);
      const pagePath = body.path || body.filepath || "";
      const tag = body.tag || "p";

      let newMd: string;
      if (tag === "ul") {
        const items = newText.split(",").map(s => s.trim()).filter(Boolean);
        newMd = items.map(i => "- " + i).join("\n") + "\n";
      } else if (tag === "ol") {
        const items = newText.split(",").map(s => s.trim()).filter(Boolean);
        newMd = items.map(i => "1. " + i).join("\n") + "\n";
      } else if (tag.startsWith("h")) {
        const depth = Math.min(parseInt(tag.slice(1), 10) || 2, 6);
        newMd = "#".repeat(depth) + " " + newText + "\n";
      } else {
        newMd = newText + "\n";
      }

      const innerHtml = renderBlock(newMd);
      const blocks = parseBlocks(newClean);
      let foundAfter = false;
      let bid: string | undefined;
      for (const b of blocks) {
        if (!foundAfter) {
          const fbid = formatBlockId({ tag: b.tag, index: b.index });
          if (fbid === (body.afterBlockId || "")) foundAfter = true;
          continue;
        }
        if (b.tag === tag) {
          bid = formatBlockId({ tag: b.tag, index: b.index });
          break;
        }
      }
      if (!bid) {
        const maxIdx = blocks.filter(b => b.tag === tag).reduce((m, b) => Math.max(m, b.index), -1);
        bid = formatBlockId({ tag, index: maxIdx + 1 });
      }
      const isList = ["ul", "ol"].includes(tag);
      return htmlResponse(200, buildHtmxShell(bid, innerHtml, isList, pagePath));
    }

    // edit: find and render target block
    const parsedBlockId = parseBlockId(body.blockId);
    if (!parsedBlockId) return jsonResponse(400, { ok: false, msg: "Invalid blockId" });
    const blocks = parseBlocks(newClean);
    const targetBlock = blocks.find(b =>
      b.tag === parsedBlockId.tag &&
      b.index === parsedBlockId.index
    );

    if (targetBlock) {
      const pagePath = body.path || body.filepath || "";
      const lines = newClean.split("\n");
      const contentStart = targetBlock.position.start.line - 1;
      const contentEnd = targetBlock.position.end.line;
      const blockMd = lines.slice(contentStart, contentEnd).join("\n") + "\n";
      const rendered = renderBlock(blockMd);
      const bid = formatBlockId({ tag: targetBlock.tag, index: targetBlock.index });
      const isList = ["ul", "ol"].includes(targetBlock.tag);
      return htmlResponse(200, buildHtmxContentInner(bid, rendered, pagePath));
    }
  }

  const msgMap: Record<string, string> = { edit: "updated", insert: "inserted", delete: "deleted", move: "moved" };
  return jsonResponse(200, { ok: true, msg: msgMap[action] });
}

// --- Source endpoint handler ---

/**
 * Source endpoint handler: returns a <textarea> HTML snippet containing
 * the raw markdown for the specified block. Delegates file I/O to MarkdownService.
 */
export async function handleSource(
  req: Request,
  config: Config,
  indexer: Indexer
): Promise<Response> {
  const isHtmx = req.headers.get("HX-Request") === "true";

  const url = new URL(req.url);
  const blockId = url.searchParams.get("blockId");
  const pagePath = url.searchParams.get("path");

  if (!blockId || !pagePath) {
    return jsonResponse(400, { ok: false, msg: "Missing blockId or path" });
  }

  const service = new MarkdownService(config, indexer);

  // Resolve filepath
  const fileResult = service.resolveFile({ path: pagePath });
  if ("error" in fileResult) {
    return jsonResponse(fileResult.error.status, { ok: false, msg: fileResult.error.msg });
  }
  const filepath = fileResult.filepath;

  // Read raw block content
  const blockResult = service.readRawBlock(filepath, blockId);
  if ("error" in blockResult) {
    return jsonResponse(blockResult.error.status, { ok: false, msg: blockResult.error.msg });
  }

  const escapedMd = escapeHtml(blockResult.raw);
  const html = `
<div class=\"mb-edit\">
  <input type=\"hidden\" name=\"blockId\" value=\"${blockId}\">
  <input type=\"hidden\" name=\"path\" value=\"${pagePath}\">
<textarea class=\"mb-source\" name=\"text\"
              autofocus>
${escapedMd}</textarea>

</div>`;

  if (isHtmx) {
    return htmlResponse(200, html);
  }
  return jsonResponse(200, { ok: true, html });
}
