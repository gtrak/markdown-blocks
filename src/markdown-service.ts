import fs from "node:fs";
import path from "node:path";
import { Config, parseBlockId, Block } from "./types.js";
import { replaceBlock, deleteBlock, insertBlock, moveBlock, moveBlockByDirection, parseBlocks } from "./ast.js";
import { deannotate, annotate } from "./annotate.js";
import { Indexer } from "./indexer.js";

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

/** Check if a resolved absolute path lives inside the given directory */
function isInsideDir(filepath: string, dir: string): boolean {
  try {
    const absFile = path.resolve(fs.realpathSync(filepath));
    const absDir = path.resolve(fs.realpathSync(dir));
    // Ensure dir ends with separator to avoid prefix collisions like /tmp/foo matching /tmp/foobar
    return absFile.startsWith(absDir + path.sep) || absFile === absDir;
  } catch {
    // If we can't resolve real paths (e.g., file doesn't exist), deny access.
    return false;
  }
}

export class MarkdownService {
  private contentDir: string;

  constructor(private config: Config, private indexer: Indexer) {
    this.contentDir = path.resolve(config.contentDir);
  }

  /** Resolve a request body to a valid filepath. Returns error if invalid. */
  resolveFile(body: SaveBody): { filepath: string } | { error: { status: number; msg: string } } {
    if (body.filepath) {
      const resolved = path.resolve(body.filepath);
      if (!isInsideDir(resolved, this.contentDir)) {
        return { error: { status: 403, msg: "Path outside contentDir" } };
      }
      return { filepath: resolved };
    } else if (body.path) {
      const resolved = this.indexer.resolve(body.path);
      if (!resolved) {
        return { error: { status: 404, msg: "Path not found" } };
      }
      if (!isInsideDir(resolved, this.contentDir)) {
        return { error: { status: 403, msg: "Path outside contentDir" } };
      }
      return { filepath: resolved };
    }
    return { error: { status: 400, msg: "Missing path or filepath" } };
  }

  /** Read and deannotate a file. Returns raw markdown content. */
  readDeannotated(filepath: string): { content: string } | { error: { status: number; msg: string } } {
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      return { content: deannotate(raw) };
    } catch {
      return { error: { status: 404, msg: "File not found" } };
    }
  }

  /** Perform the edit mutation on deannotated content. */
  edit(cleanContent: string, blockIdStr: string, text: string): { result: string; success: boolean } | { error: { status: number; msg: string } } {
    const parsedId = parseBlockId(blockIdStr);
    if (!parsedId) return { error: { status: 400, msg: "Invalid blockId" } };
    const r = replaceBlock(cleanContent, parsedId, text);
    return { result: r.result, success: r.success };
  }

  /** Perform the delete mutation on deannotated content. */
  del(cleanContent: string, blockIdStr: string): { result: string; success: boolean } | { error: { status: number; msg: string } } {
    const parsedId = parseBlockId(blockIdStr);
    if (!parsedId) return { error: { status: 400, msg: "Invalid blockId" } };
    return deleteBlock(cleanContent, parsedId);
  }

  /** Perform the insert mutation on deannotated content. */
  insert(cleanContent: string, afterBlockIdStr: string, tag: string, text: string): { result: string; success: boolean } | { error: { status: number; msg: string } } {
    const afterId = parseBlockId(afterBlockIdStr);
    if (!afterId) return { error: { status: 400, msg: "Invalid afterBlockId" } };
    return insertBlock(cleanContent, afterId, tag, text);
  }

  /** Perform the move mutation on deannotated content. */
  move(cleanContent: string, blockIdStr: string, direction?: string, beforeBlockIdStr?: string): { result: string; success: boolean } | { error: { status: number; msg: string } } {
    const parsedId = parseBlockId(blockIdStr);
    if (!parsedId) return { error: { status: 400, msg: "Invalid blockId" } };

    if (direction) {
      return moveBlockByDirection(cleanContent, parsedId, direction as "up" | "down");
    } else {
      const beforeId = beforeBlockIdStr != null && beforeBlockIdStr !== "" ? parseBlockId(beforeBlockIdStr) : null;
      return moveBlock(cleanContent, parsedId, beforeId);
    }
  }

  /** Read a file, deannotate, re-annotate result, and atomic-write. Returns the annotated content on success. */
  mutateAndWrite(filepath: string, cleanContent: string, newClean: string): { success: boolean; annotated: string } | { error: { status: number; msg: string } } {
    const annotated = annotate(newClean);
    return this.writeAtomically(filepath, annotated);
  }

  /** Atomic write: write to .tmp then rename. */
  writeAtomically(filepath: string, annotated: string): { success: boolean; annotated: string } | { error: { status: number; msg: string } } {
    const tmpPath = filepath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, annotated, "utf-8");
      fs.renameSync(tmpPath, filepath);
      return { success: true, annotated };
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { error: { status: 500, msg: `Write failed: ${String(err)}` } };
    }
  }

  /** Read raw block content from a file for the /source endpoint. */
  readRawBlock(filepath: string, blockIdStr: string): { raw: string; block: Block } | { error: { status: number; msg: string } } {
    const readResult = this.readDeannotated(filepath);
    if ("error" in readResult) return readResult as { error: { status: number; msg: string } };

    const blocks = parseBlocks(readResult.content);
    const parsedId = parseBlockId(blockIdStr);
    if (!parsedId) return { error: { status: 400, msg: "Invalid blockId" } };

    const targetBlock = blocks.find(b => b.tag === parsedId.tag && b.index === parsedId.index);
    if (!targetBlock) return { error: { status: 404, msg: "Block not found" } };

    const lines = readResult.content.split("\n");
    const contentStart = targetBlock.position.start.line - 1;
    const contentEnd = targetBlock.position.end.line;
    const raw = lines.slice(contentStart, contentEnd).join("\n");

    return { raw, block: targetBlock };
  }
}
