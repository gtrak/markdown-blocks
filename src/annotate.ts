import fs from "node:fs";
import path from "node:path";
import { parseBlocks } from "./ast.js";
import { Block, formatBlockId } from "./types.js";

const ANNOTATION_RE = /^<!-- markdown-blocks:[^>]+ -->\r?\n?/gm;

/**
 * Remove all `<!-- markdown-blocks:tag-index -->` annotations from source.
 * Safe to call even if already clean (idempotent).
 */
export function deannotate(source: string): string {
  const cleaned = source.replace(ANNOTATION_RE, "");
  return cleaned.replace(/\n{3,}/g, "\n\n");
}

/**
 * Parse blocks, then prepend `<!-- markdown-blocks:tag-index -->` comment
 * before each block in source. Returns annotated source.
 */
export function annotate(source: string): string {
  const clean = deannotate(source);
  const blocks = parseBlocks(clean);

  // Only annotate top-level blocks — list items are discovered dynamically in HTML
  const topLevel = blocks.filter(b => b.itemIndex === undefined);
  if (topLevel.length === 0) return clean;

  // Split into lines, preserving line endings
  const lines = clean.split("\n");

  // Process in reverse order so insertions don't shift earlier positions
  for (let i = topLevel.length - 1; i >= 0; i--) {
    const block = topLevel[i];
    const startLine = block.position.start.line; // 1-indexed from mdast
    const annotation = `<!-- markdown-blocks:${formatBlockId({ tag: block.tag, index: block.index })} -->`;
    lines.splice(startLine - 1, 0, annotation);
  }

  return lines.join("\n");
}

/**
 * Scan all .md files in contentDir: call fn on each file content, write result back atomically.
 */
function processAllFiles(contentDir: string, fn: (content: string) => string): void {
  if (!fs.existsSync(contentDir) || !fs.statSync(contentDir).isDirectory()) return;

  const files = walkMarkdownFiles(contentDir);
  for (const filepath of files) {
    const content = fs.readFileSync(filepath, "utf-8");
    const result = fn(content);
    try {
      fs.writeFileSync(filepath + ".tmp", result, "utf-8");
      fs.renameSync(filepath + ".tmp", filepath);
      console.log(`[annotate] processed: ${path.basename(filepath)}`);
    } catch (err) {
      // Clean up .tmp on failure
      try { fs.unlinkSync(filepath + ".tmp"); } catch {}
      throw err;
    }
  }
}

/** Recursively find all .md files, skipping hidden files and directories. */
export function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip hidden
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
    } else if (path.extname(entry.name) === ".md") {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * De-annotate all .md files in contentDir.
 * Safe to call on startup (crash recovery).
 */
export function deannotateAll(contentDir: string): void {
  processAllFiles(contentDir, deannotate);
}

/**
 * Annotate all .md files in contentDir.
 * Called after deannotateAll on server startup.
 */
export function annotateAll(contentDir: string): void {
  processAllFiles(contentDir, annotate);
}

// --- Inline tests ---
if (import.meta.main) {
  const original = `---
title: Test Post
date: 2024-01-01
---

# Hello World

This is a paragraph.

## Section Two

Another paragraph here.
`;

  // Test 1: deannotate removes comments
  {
    const annotated = annotate(original);
    const result = deannotate(annotated);
    if (result !== original) throw new Error("deannotate does not remove annotations");
    console.log("PASS: deannotate removes comments");
  }

  // Test 2: annotate adds comments before blocks
  {
    const annotated = annotate(original);
    if (!annotated.includes("<!-- markdown-blocks:h1-0 -->")) {
      throw new Error("annotate missing h1-0 annotation");
    }
    console.log("PASS: annotate adds comments before blocks");
  }

  // Test 3: roundtrip (whitespace-normalized)
  {
    const annotated = annotate(original);
    const result = deannotate(annotated);
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (normalize(result) !== normalize(original)) throw new Error("roundtrip changed content");
    console.log("PASS: annotate->deannotate roundtrip");
  }

  // Test 4: frontmatter survives annotation
  {
    const annotated = annotate(original);
    if (!annotated.startsWith("---")) throw new Error("frontmatter lost during annotation");
    console.log("PASS: frontmatter survives annotation");
  }

  // Test 5: empty file works
  {
    const result = annotate("");
    if (result !== "") throw new Error("empty file changed");
    const deann = deannotate("");
    if (deann !== "") throw new Error("deannotate empty file changed");
    console.log("PASS: empty file works");
  }

  console.log("\nAll annotate tests passed.");
}
