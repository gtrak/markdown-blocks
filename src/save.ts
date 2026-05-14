import fs from "node:fs";
import path from "node:path";
import { Config, parseBlockId, formatBlockId } from "./types.js";
import { replaceBlock, deleteBlock, insertBlock, moveBlock, moveBlockByDirection, parseBlocks } from "./ast.js";
import { deannotate, annotate } from "./annotate.js";
import { Indexer } from "./indexer.js";
import { buildHtmxShell, buildHtmxContentInner } from "./inject.js";
import { renderBlock, escapeHtml } from "./render.js";

// --- Helper exports for testing ---

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

// --- Save body type ---

export interface SaveBody {
  path?: string;
  filepath?: string;
  action?: "edit" | "insert" | "delete" | "move";
  blockId?: string;
  afterBlockId?: string;   // insert destination
  beforeBlockId?: string;  // move destination (null = end)
  tag?: string;            // insert type: "h1", "h2", "p", etc.
  text?: string;
  direction?: "up" | "down";
}

// --- Security helpers ---

/** Check if a resolved absolute path lives inside the given directory */
function isInsideDir(filepath: string, dir: string): boolean {
  const absFile = path.resolve(filepath);
  const absDir = path.resolve(dir);
  // Ensure dir ends with separator to avoid prefix collisions like /tmp/foo matching /tmp/foobar
  return absFile.startsWith(absDir + path.sep) || absFile === absDir;
}

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

// --- Main handler ---

/**
 * Fetch-compatible save handler. Replaces a single block in a markdown file
 * using AST position-aware replacement.
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

  // --- Resolve filepath ---
  const contentDir = path.resolve(config.contentDir);

  let filepath: string;
  if (body.filepath) {
    const resolved = path.resolve(body.filepath);
    if (!isInsideDir(resolved, contentDir)) {
      return jsonResponse(403, { ok: false, msg: "Path outside contentDir" });
    }
    filepath = resolved;
  } else if (body.path) {
    const resolved = indexer.resolve(body.path);
    if (!resolved) {
      return jsonResponse(404, { ok: false, msg: `Path not found` });
    }
    if (!isInsideDir(resolved, contentDir)) {
      return jsonResponse(403, { ok: false, msg: "Path outside contentDir" });
    }
    filepath = resolved;
  } else {
    return jsonResponse(400, { ok: false, msg: "Missing path or filepath" });
  }

  // --- Read source file ---
  let content: string;
  try {
    content = fs.readFileSync(filepath, "utf-8");
  } catch {
    return jsonResponse(404, { ok: false, msg: `File not found` });
  }

  // --- Sanitize text ---
  let newText = body.text ?? "";


  // --- Route mutation by action ---
  let mutationResult: { result: string; success?: boolean };
  const cleanContent = deannotate(content);

  if (action === "edit") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const parsedId = parseBlockId(body.blockId);
    if (!parsedId) return jsonResponse(400, { ok: false, msg: "Invalid blockId" });
    const r = replaceBlock(cleanContent, parsedId, newText);
    mutationResult = { result: r.result, success: r.success };
  } else if (action === "delete") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const parsedId = parseBlockId(body.blockId);
    if (!parsedId) return jsonResponse(400, { ok: false, msg: "Invalid blockId" });
    mutationResult = deleteBlock(cleanContent, parsedId);
  } else if (action === "insert") {
    if (!body.afterBlockId) return jsonResponse(400, { ok: false, msg: "Missing afterBlockId" });
    const afterId = parseBlockId(body.afterBlockId);
    if (!afterId) return jsonResponse(400, { ok: false, msg: "Invalid afterBlockId" });
    if (!body.tag) return jsonResponse(400, { ok: false, msg: "Missing tag" });
    mutationResult = insertBlock(cleanContent, afterId, body.tag, newText);
  } else if (action === "move") {
    if (!body.blockId) return jsonResponse(400, { ok: false, msg: "Missing blockId" });
    const parsedId = parseBlockId(body.blockId);
    if (!parsedId) return jsonResponse(400, { ok: false, msg: "Invalid blockId" });

    if (body.direction) {
      mutationResult = moveBlockByDirection(cleanContent, parsedId, body.direction);
    } else {
      const beforeId = body.beforeBlockId != null && body.beforeBlockId !== "" ? parseBlockId(body.beforeBlockId) : null;
      mutationResult = moveBlock(cleanContent, parsedId, beforeId);
    }
  } else {
    return jsonResponse(400, { ok: false, msg: "Unknown action" });
  }

  if (!mutationResult.success) {
    return jsonResponse(400, { ok: false, msg: `${action} failed: block not found` });
  }
  const annotated = annotate(mutationResult.result);

  // --- Atomic write ---
  const tmpPath = filepath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, annotated, "utf-8");
    fs.renameSync(tmpPath, filepath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }
    return jsonResponse(500, { ok: false, msg: `Write failed: ${String(err)}` });
  }

  // --- HTMX response ---
  if (isHtmx) {
    const newClean = deannotate(annotated);

   if (action === "move") {
      // Move is handled client-side (DOM rearrangement). Just return success.
      return jsonResponse(200, { ok: true });
    }

    if (action === "delete") {
      return htmlResponse(200, "");
    }

    // edit / insert: wrap just the changed block
    if (action === "insert") {
      const afterParsed = parseBlockId(body.afterBlockId!);
      const pagePath = body.path || body.filepath || "";

      // Insert: compose markdown for the new block, render via renderBlock
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
        newMd = newText + "\n"; // p, blockquote, etc.
      }
      const innerHtml = renderBlock(newMd);
      // Block ID: find the newly inserted block among all parsed blocks.
      // It's the first block of this tag type that comes after the insertion point.
      const blocks = parseBlocks(newClean);
      let foundAfter = false;
      let bid: string | undefined;
      for (const b of blocks) {
        if (!foundAfter) {
          // Walk forward until we find the insertion target
          const fbid = formatBlockId({ tag: b.tag, index: b.index });
          if (fbid === (body.afterBlockId || "")) foundAfter = true;
          continue;
        }
        // First block of matching tag after the insertion point = our new block
        if (b.tag === tag) {
          bid = formatBlockId({ tag: b.tag, index: b.index });
          break;
        }
      }
      if (!bid) {
        // Fallback: max index + 1 for this tag
        const maxIdx = blocks.filter(b => b.tag === tag).reduce((m, b) => Math.max(m, b.index), -1);
        bid = formatBlockId({ tag, index: maxIdx + 1 });
      }
      const isList = ["ul", "ol"].includes(tag);
      return htmlResponse(200, buildHtmxShell(bid, innerHtml, isList, pagePath));
    }

    const parsedBlockId = parseBlockId(body.blockId!);

    // Block edits: find the target and render it
    const blocks = parseBlocks(newClean);
    const targetBlock = blocks.find(b =>
      b.tag === parsedBlockId!.tag &&
      b.index === parsedBlockId!.index
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

// --- Source endpoint ---

/**
 * Source endpoint handler: returns a <textarea> HTML snippet containing
 * the raw markdown for the specified block. Called via htmx GET /source.
 */
export async function handleSource(
  req: Request,
  config: Config,
  indexer: Indexer
): Promise<Response> {
  const isHtmx = req.headers.get("HX-Request") === "true";

  // Parse query params (htmx sends blockId and path via hx-vals)
  const url = new URL(req.url);
  const blockId = url.searchParams.get("blockId");
  const pagePath = url.searchParams.get("path");

  if (!blockId || !pagePath) {
    return jsonResponse(400, { ok: false, msg: "Missing blockId or path" });
  }

  // --- Resolve filepath (same security logic as handleSave) ---
  const contentDir = path.resolve(config.contentDir);

  let filepath: string;
  const resolved = indexer.resolve(pagePath);
  if (!resolved) {
    return jsonResponse(404, { ok: false, msg: "Path not found" });
  }
  if (!isInsideDir(resolved, contentDir)) {
    return jsonResponse(403, { ok: false, msg: "Path outside contentDir" });
  }
  filepath = resolved;

  // --- Read source file ---
  let content: string;
  try {
    content = fs.readFileSync(filepath, "utf-8");
  } catch {
    return jsonResponse(404, { ok: false, msg: "File not found" });
  }

  // --- Find target block and extract raw markdown ---
  const cleanContent = deannotate(content);
  const blocks = parseBlocks(cleanContent);
  const parsedId = parseBlockId(blockId);
  if (!parsedId) {
    return jsonResponse(400, { ok: false, msg: "Invalid blockId" });
  }

  const targetBlock = blocks.find(
    b => b.tag === parsedId.tag && b.index === parsedId.index
  );
  if (!targetBlock) {
    return jsonResponse(404, { ok: false, msg: "Block not found" });
  }

  // Extract raw markdown lines from source positions
  const lines = cleanContent.split("\n");
  const contentStart = targetBlock.position.start.line - 1;
  const contentEnd = targetBlock.position.end.line;
  const blockMd = lines.slice(contentStart, contentEnd).join("\n");

  // Escape the markdown for safe embedding in HTML
  const escapedMd = escapeHtml(blockMd);

  // Return HTML snippet with textarea
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
