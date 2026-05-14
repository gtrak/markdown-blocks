import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown, frontmatterToMarkdown } from "mdast-util-frontmatter";
import { toMarkdown } from "mdast-util-to-markdown";
import { frontmatter as micromarkFrontmatter } from "micromark-extension-frontmatter";
import type { Root, Node } from "mdast-util-from-markdown/lib";
import * as yaml from "yaml";
import { parse as parseToml } from "smol-toml";
import { Block, BlockId } from "./types.js";

// --- Parser helpers ---

const parseOptions = {
  extensions: [micromarkFrontmatter(["yaml", "toml"])],
  mdastExtensions: [frontmatterFromMarkdown(["yaml", "toml"])],
} as const;

const serializeOptions = {
  extensions: [frontmatterToMarkdown(["yaml", "toml"])],
} as const;

/** Parse markdown source (including frontmatter) into a complete AST. */
function parse(source: string): Root {
  return fromMarkdown(source, parseOptions) as Root;
}

/** Serialize an AST tree back to markdown text. */
function serialize(tree: Node): string {
  return toMarkdown(tree, serializeOptions);
}

/** Normalize CRLF to LF so the AST pipeline always works with uniform line endings. */
function normalizeEol(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

// --- Frontmatter extraction ---

/**
 * Extract frontmatter using the mdast AST pipeline.
 * Supports both --- (YAML) and +++ (TOML) delimiters.
 * Returns the raw frontmatter string (with delimiters), content after it,
 * and parsed key-value pairs.
 */
export function extractFrontmatter(source: string): { fm: string | null; content: string; parsed: Record<string, unknown> } {
  source = normalizeEol(source);
  const tree = parse(source);
  const fmNode = tree.children.find(c => c.type === "yaml" || c.type === "toml");

  if (!fmNode || !fmNode.position) {
    return { fm: null, content: source, parsed: {} };
  }

  // Extract raw frontmatter from source using AST position
  const fmText = source.slice(fmNode.position.start.offset, fmNode.position.end.offset);

  let parsed: Record<string, unknown> = {};
  try {
    if (fmNode.type === "yaml") {
      parsed = yaml.parse((fmNode as unknown as { value: string }).value) || {};
    } else {
      // TOML: use smol-toml for proper parsing
      const nodeValue = (fmNode as unknown as { value: string }).value;
      parsed = parseToml(nodeValue) || {};
    }
    if (typeof parsed !== "object" || parsed === null) parsed = {};
  } catch {
    // parsing failed — parsed stays {}
  }

  const content = source.slice(fmNode.position.end.offset);
  return { fm: fmText, content, parsed };
}

// --- Block parsing ---

/** Map mdast node type to Block tag. Returns null if node should be skipped. */
function resolveTag(node: Node): string | null {
  switch (node.type) {
    case "heading":
      return `h${(node as { depth: number }).depth}`;
    case "paragraph":
      return "p";
    case "code":
      return "code";
    case "blockquote":
      return "blockquote";
    case "list":
      return (node as { ordered: boolean }).ordered ? "ol" : "ul";
    default:
      return null;
  }
}

/** Recursively collect block-level nodes with per-tag sequential indices. */
function collectBlocks(node: Root | Node): Block[] {
  const blocks: Block[] = [];
  const indexCounter: Record<string, number> = {};

  function recurse(n: Node) {
    // Skip frontmatter nodes — they are not editable blocks
    if (n.type === "yaml" || n.type === "toml") return;

    const tag = resolveTag(n);
    if (tag && n.position) {
      if (!(tag in indexCounter)) indexCounter[tag] = 0;

      blocks.push({
        tag,
        index: indexCounter[tag]++,
        position: {
          start: { line: n.position.start.line, column: n.position.start.column },
          end: { line: n.position.end.line, column: n.position.end.column },
        },
      });

    }

    // Recurse into list children to discover nested lists, but skip paragraphs
    // inside list items (they should not be independent top-level blocks).
    const children = (n as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        // Skip recursion into ListItem children: their nested paragraphs would be
        // double-registered. Nested lists are NOT registered as separate blocks —
        // Zola renders them as flat sibling <ul> elements, so the outer list
        // handles all items including nested ones.
        if (child.type !== "listItem") {
          recurse(child);
        }
      }
    }
  }

  recurse(node);
  blocks.sort((a, b) => a.position.start.line - b.position.start.line);
  return blocks;
}

/**
 * Parse markdown source into Block array using mdast.
 * Recognizes and skips both YAML (---) and TOML (+++) frontmatter.
 */
export function parseBlocks(source: string): Block[] {
  source = normalizeEol(source);
  const tree = parse(source);
  return collectBlocks(tree);
}

// --- Block replacement ---

/** Compose markdown text for a single block from tag name and plain text. */
function composeMarkdown(tag: string, text: string): string {
  if (tag.startsWith("h")) {
    const depth = Math.min(parseInt(tag.slice(1), 10) || 2, 6);
    return "#".repeat(depth) + " " + text;
  }
  if (tag === "blockquote") return "> " + text;
  // Paragraphs: turn plain newlines into hard line breaks (two trailing spaces)
  if (tag === "p") {
    return text.replace(/\n/g, "  \n");
  }
  return text; // code, etc.
}

/** Replace a specific block in the source by its tag+index. */
export function replaceBlock(source: string, blockId: BlockId, newText: string): { result: string; success: boolean } {
  source = normalizeEol(source);
  const blocks = parseBlocks(source);
  const target = blocks.find(b => b.tag === blockId.tag && b.index === blockId.index);
  if (!target) return { result: source, success: false };

  const lines = source.split("\n");
  const startLine = target.position.start.line - 1; // mdast is 1-indexed
  const endLine = target.position.end.line;         // exclusive boundary in lines array

  // Check if there's a trailing blank line after the block (block separation)
  let includeTrailingBlank = false;
  const nextLine = lines[endLine];
  if (nextLine === undefined || nextLine.trim() === "") {
    includeTrailingBlank = true;
  }

  const replaceCount = endLine - startLine + (includeTrailingBlank ? 1 : 0);
  // Detect if newText is already formatted markdown (has heading/blockquote syntax)
  const hasMdSyntax = /^#+\s/.test(newText) || /^>\s/.test(newText);
  const newMd = hasMdSyntax ? newText : composeMarkdown(blockId.tag, newText);
  const newLines = newMd.split("\n");
  if (includeTrailingBlank) newLines.push("");

  lines.splice(startLine, replaceCount, ...newLines);
  return { result: lines.join("\n"), success: true };
}

// --- Block deletion ---

/** Delete a specific block in the source by its tag+index. */
export function deleteBlock(source: string, blockId: BlockId): { result: string; success: boolean } {
  source = normalizeEol(source);
  const blocks = parseBlocks(source);
  const target = blocks.find(b => b.tag === blockId.tag && b.index === blockId.index);
  if (!target) return { result: source, success: false };

  const lines = source.split("\n");
  const startLine = target.position.start.line - 1;
  const endLine = target.position.end.line;

  // Check for trailing blank line (block separator)
  const nextLine = lines[endLine];
  let includeTrailingBlank = false;
  if (nextLine === undefined || nextLine.trim() === "") {
    includeTrailingBlank = true;
  }

  const deleteCount = (endLine - startLine) + (includeTrailingBlank ? 1 : 0);
  lines.splice(startLine, deleteCount);

  return { result: lines.join("\n"), success: true };
}

// --- Block insertion ---

/**
 * Insert a new block after the block identified by afterBlockId.
 */
export function insertBlock(source: string, afterBlockId: BlockId, tag: string, text: string): { result: string; success: boolean } {
  source = normalizeEol(source);
  const blocks = parseBlocks(source);
  const afterBlock = blocks.find(b => b.tag === afterBlockId.tag && b.index === afterBlockId.index);
  if (!afterBlock) return { result: source, success: false };

  const lines = source.split("\n");
  const endLine = afterBlock.position.end.line; // insert AFTER this line

  const newMd = composeMarkdown(tag, text);
  const newLines = ["", ...newMd.split("\n"), ""]; // blank lines before and after
  lines.splice(endLine, 0, ...newLines);

  return { result: lines.join("\n"), success: true };
}

// --- Block movement ---

/**
 * Move a block to a new position. If beforeBlockId is null, append to end of root children.
 */
export function moveBlock(source: string, blockId: BlockId, beforeBlockId: BlockId | null): { result: string; success: boolean } {
  source = normalizeEol(source);
  const blocks = parseBlocks(source);
  const srcTarget = blocks.find(b => b.tag === blockId.tag && b.index === blockId.index);
  if (!srcTarget) return { result: source, success: false };

  const lines = source.split("\n");
  const srcStart = srcTarget.position.start.line - 1; // 0-indexed
  const srcEnd = srcTarget.position.end.line;         // exclusive boundary in lines array

  // Check for trailing blank separator (block separation), same as replaceBlock does
  let includeTrailingBlank = false;
  if (lines[srcEnd] !== undefined && lines[srcEnd].trim() === "") {
    includeTrailingBlank = true;
  }

  // Extract raw content only (no trailing blank)
  const rawContent = lines.slice(srcStart, srcEnd);

  if (beforeBlockId === null) {
    // Move to end: delete source, append at end
    const count = srcEnd - srcStart + (includeTrailingBlank ? 1 : 0);
    lines.splice(srcStart, count);
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(...rawContent);
  } else {
    // Find destination block
    const destTarget = blocks.find(b => b.tag === beforeBlockId.tag && b.index === beforeBlockId.index);
    if (!destTarget) return { result: source, success: false };

    // Use destination START position for insertion (insert BEFORE the dest block)
    const insertPos = destTarget.position.start.line - 1; // 0-indexed array position

    // Determine if source is before or after dest's end (to decide delete-first vs insert-first)
    const destEnd = destTarget.position.end.line;
    if (srcStart < destEnd) {
      // Source BEFORE destination: delete first, then insert
      const count = srcEnd - srcStart + (includeTrailingBlank ? 1 : 0);
      lines.splice(srcStart, count);
      const adjustedInsert = Math.max(insertPos - count, 0);
      lines.splice(adjustedInsert, 0, ...rawContent);
    } else {
      // Source AFTER destination: insert first, then delete
      lines.splice(insertPos, 0, ...rawContent);
      // Delete original source + trailing blank if present. If there's a gap between
      // destEnd and srcStart (orphaned leading blank after insertion), also remove it.
      const hasOrphanLeadingBlank = srcStart > destEnd + 1;
      const count = (srcEnd - srcStart) + (includeTrailingBlank ? 1 : 0) + (hasOrphanLeadingBlank ? 1 : 0);
      lines.splice(srcStart + rawContent.length, count);
    }
  }

  return { result: lines.join("\n"), success: true };
}

/**
 * Move a block up or down one position in the document.
 * Finds the block's position in the ordered block list, then calls moveBlock
 * with the correct beforeBlockId (or null for end).
 */
export function moveBlockByDirection(
  source: string,
  blockId: BlockId,
  direction: "up" | "down",
): { result: string; success: boolean } {
  source = normalizeEol(source);
  const blocks = parseBlocks(source);
  const idx = blocks.findIndex((b) => b.tag === blockId.tag && b.index === blockId.index);
  if (idx === -1) return { result: source, success: false };

  if (direction === "up") {
    if (idx === 0) return { result: source, success: false }; // already first
    const before = blocks[idx - 1];
    return moveBlock(source, blockId, { tag: before.tag, index: before.index });
  } else {
    // down
    if (idx >= blocks.length - 1) return { result: source, success: false }; // already last
    const after = blocks[idx + 1];
    // We want to move AFTER `after`, which means BEFORE the block after `after`
    if (idx + 2 < blocks.length) {
      const beforeNext = blocks[idx + 2];
      return moveBlock(source, blockId, { tag: beforeNext.tag, index: beforeNext.index });
    }
    // No block after `after` — move to end
    return moveBlock(source, blockId, null);
  }
}

// --- Inline tests ---

export {} // suppress module warning for import.meta.main check

if (import.meta.main) {
  const pass = (name: string, ok: boolean) => console.log(ok ? `PASS ${name}` : `FAIL ${name}`);
  let failures = 0;
  const fail = (name: string, msg?: string) => { failures++; console.log(`FAIL ${name}${msg ? ": " + msg : ""}`); };

  const src1 = `# Heading A\n\n# Heading B\n\nA paragraph.\n`;


  // 1. deleteBlock: delete h1-0, result should have h1 B and paragraph
  {
    const r = deleteBlock(src1, { tag: "h1", index: 0 });
    if (r.success) {
      const blocks = parseBlocks(r.result);
      const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
      if (tags === "h1-0,p-0") pass("deleteBlock h1-0", true);
      else fail("deleteBlock h1-0", `got ${tags}`);
    } else fail("deleteBlock h1-0", "not deleted");
  }

  // 2. insertBlock: insert h2 after h1-0
  {
    const r = insertBlock(src1, { tag: "h1", index: 0 }, "h2", "Subheading");
    if (r.success) {
      const blocks = parseBlocks(r.result);
      const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
      if (tags === "h1-0,h2-0,h1-1,p-0") pass("insertBlock h2 after h1-0", true);
      else fail("insertBlock h2 after h1-0", `got ${tags}`);
    } else fail("insertBlock h2 after h1-0", "not inserted");
  }

  // 3. insertBlock paragraph: insert p after p-0
  {
    const r = insertBlock(src1, { tag: "p", index: 0 }, "p", "Another paragraph.");
    if (r.success) {
      const blocks = parseBlocks(r.result);
      const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
      if (tags === "h1-0,h1-1,p-0,p-1") pass("insertBlock p after p-0", true);
      else fail("insertBlock p after p-0", `got ${tags}`);
    } else fail("insertBlock p after p-0", "not inserted");
  }

  // 4. moveBlock: move p-0 before h1-0 (paragraph comes first)
  {
    const r = moveBlock(src1, { tag: "p", index: 0 }, { tag: "h1", index: 0 });
    if (r.success) {
      const blocks = parseBlocks(r.result);
      const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
      if (tags === "p-0,h1-0,h1-1") pass("moveBlock p-0 before h1-0", true);
      else fail("moveBlock p-0 before h1-0", `got ${tags}`);
    } else fail("moveBlock p-0 before h1-0", "not moved");
  }

  // 5. moveBlock to end: move h1-0 to end (beforeBlockId=null)
  {
    const r = moveBlock(src1, { tag: "h1", index: 0 }, null);
    if (r.success) {
      const blocks = parseBlocks(r.result);
      const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
      if (tags === "h1-0,p-0,h1-1") pass("moveBlock h1-0 to end", true);
      else fail("moveBlock h1-0 to end", `got ${tags}`);
    } else fail("moveBlock h1-0 to end", "not moved");
  }

  // 6. Roundtrip: delete h1-0 then insert back before h1 (which is now index 0)
  {
    const d = deleteBlock(src1, { tag: "h1", index: 0 });
    if (d.success) {
      // Insert a new h1 before the remaining h1-0 (which was originally h1-1)
      const i = insertBlock(d.result, { tag: "p", index: 0 }, "h1", "Heading A");
      if (i.success) {
        const blocks = parseBlocks(i.result);
        const tags = blocks.map(b => b.tag + "-" + b.index).join(",");
        if (tags === "h1-0,p-0,h1-1") pass("roundtrip delete+insert", true);
        else fail("roundtrip delete+insert", `got ${tags}`);
      } else fail("roundtrip delete+insert", "not inserted");
    } else fail("roundtrip delete+insert", "not deleted");
  }

  console.log(failures === 0 ? `\nAll inline tests passed.` : `\n${failures} test(s) failed.`);
}

// --- Re-export for config.ts consumers who need frontmatter parsing. ---

/** Re-export for config.ts consumers who need frontmatter parsing. */
export { extractFrontmatter as extractFmAst };
