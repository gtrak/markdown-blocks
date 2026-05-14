import { test, expect, describe, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Source module imports ---
   import { parseBlocks, replaceBlock, extractFrontmatter, moveBlockByDirection } from "../src/ast.js";
   import { parseBlockId, formatBlockId, type Block, type Config } from "../src/types.js";
   import { injectHtmxShells, injectUneditableBanner } from "../src/inject.js";
  import { handleSave, handleSource } from "../src/save.js";
   import { Indexer, buildIndex } from "../src/indexer.js";
    import { annotate, deannotate } from "../src/annotate.js";

// --- Test fixture ---
const FIXTURE = `---
title: Test Page
---

# My Heading

This is a paragraph with some text.

## Second Heading

Another paragraph here.
`;

const FIXTURE_NO_FM = `# No Frontmatter

Just a paragraph.
`;

// ============================================================
// "AST Parser" tests
// ============================================================
describe("AST Parser", () => {
  test("parseBlocks returns correct tags for headings and paragraphs", () => {
    const blocks = parseBlocks(FIXTURE);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "p", "h2", "p"]);
  });

  test("Multiple h1s get sequential indices (h1-0, h1-1)", () => {
    const src = "# First\n\n# Second\n";
    const blocks = parseBlocks(src);
    expect(blocks.length).toBe(2);
    expect(blocks[0].tag).toBe("h1");
    expect(blocks[0].index).toBe(0);
    expect(blocks[1].tag).toBe("h1");
    expect(blocks[1].index).toBe(1);
  });

  test("Blocks are sorted by source position", () => {
    const blocks = parseBlocks(FIXTURE);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].position.start.line).toBeGreaterThanOrEqual(
        blocks[i - 1].position.start.line,
      );
    }
  });

  test("Frontmatter is skipped in block positions", () => {
    const blocks = parseBlocks(FIXTURE);
    // First content line after FM starts at line > 3 (FM occupies lines 1-3)
    expect(blocks[0].position.start.line).toBeGreaterThan(1);
  });

  test("Empty file returns empty blocks", () => {
    const blocks = parseBlocks("");
    expect(blocks.length).toBe(0);
  });

  test("No frontmatter file works fine", () => {
    const blocks = parseBlocks(FIXTURE_NO_FM);
    expect(blocks.length).toBe(2);
    expect(blocks[0].tag).toBe("h1");
    expect(blocks[0].position.start.line).toBe(1);
  });
  test("nested list items belong to outer list", () => {
    const src = "- Item one\n  - Sub a\n  - Sub b\n- Item two\n- Item three\n";
    const blocks = parseBlocks(src);
    // Only ul-0 should be registered, not ul-1. Nested lists are NOT
    // separate blocks — Zola renders them as flat sibling <ul> elements
    // and the outer list shell handles all items.
    expect(blocks.length).toBe(1);
    expect(blocks[0].tag).toBe("ul");
    expect(blocks[0].index).toBe(0);
  });
});

// ============================================================
// "Block ID Parsing" tests
// ============================================================
describe("Block ID Parsing", () => {
  test('parseBlockId("h1-3") yields { tag: "h1", index: 3 }', () => {
    expect(parseBlockId("h1-3")).toEqual({ tag: "h1", index: 3 });
  });

  test('parseBlockId("p-0") yields { tag: "p", index: 0 }', () => {
    expect(parseBlockId("p-0")).toEqual({ tag: "p", index: 0 });
  });

  test("formatBlockId reverses parseBlockId", () => {
    const id = parseBlockId("h2-5");
    expect(id).not.toBeNull();
    expect(formatBlockId(id!)).toBe("h2-5");
  });
});

// ============================================================
// "Frontmatter" tests
// ============================================================
describe("Frontmatter", () => {
  test("Frontmatter extracted correctly with --- delimiters", () => {
    const result = extractFrontmatter(FIXTURE);
    expect(result.fm).not.toBeNull();
    expect(result.parsed.title).toBe("Test Page");
    expect(result.content.trimStart().startsWith("#")).toBe(true);
  });

  test("Frontmatter preserved when replacing a block", () => {
    const result = replaceBlock(FIXTURE, { tag: "h1", index: 0 }, "New Title");
    expect(result.success).toBe(true);
    // Frontmatter lines must still be present
    expect(result.result.startsWith("---")).toBe(true);
    expect(result.result.includes("title: Test Page")).toBe(true);
  });
});

// ============================================================
// "Replace Block" tests
// ============================================================
describe("Replace Block", () => {
  test("Replace heading — text changed, frontmatter preserved, other blocks untouched", () => {
    const result = replaceBlock(FIXTURE, { tag: "h1", index: 0 }, "New Title");
    expect(result.success).toBe(true);
    expect(result.result.includes("title: Test Page")).toBe(true);
    expect(result.result.includes("This is a paragraph")).toBe(true);
  });

  test("Replace paragraph — same isolation guarantees", () => {
    const result = replaceBlock(
      FIXTURE,
      { tag: "p", index: 0 },
      "Brand new text.",
    );
    expect(result.success).toBe(true);
    expect(result.result.includes("# My Heading")).toBe(true);
    expect(result.result.includes("Brand new text.")).toBe(true);
  });

  test("Delete heading (empty text) — heading removed cleanly", () => {
    const result = replaceBlock(FIXTURE, { tag: "h1", index: 0 }, "");
    expect(result.success).toBe(true);
    // Heading text should be gone; frontmatter should survive
    expect(result.result.startsWith("---")).toBe(true);
    expect(result.result.includes("My Heading")).toBe(false);
  });

  test("Replace h2 ATX heading — works with # format too", () => {
    const result = replaceBlock(FIXTURE, { tag: "h2", index: 0 }, "Updated H2");
    expect(result.success).toBe(true);
    expect(result.result.includes("## Updated H2")).toBe(true);
  });

  test("Nonexistent blockId — returns success: false", () => {
    const result = replaceBlock(FIXTURE, { tag: "h99", index: 0 }, "ghost");
    expect(result.success).toBe(false);
    expect(result.result).toBe(FIXTURE);
  });
});

// ============================================================
// "Injector" tests
// ============================================================
describe("Injector", () => {
  const blockFixture: Block = {
    tag: "h1",
    index: 0,
    position: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  };

  test("injectHtmxShells wraps blocks with data-block-id attributes", () => {
    const html = "<main><h1>Title</h1></main>";
    const result = injectHtmxShells(html, [blockFixture]);
    expect(result.includes('data-block-id="h1-0"')).toBe(true);
    expect(result.includes("class=\"mb-block\"")).toBe(true);
    expect(result.includes('data-mb-action="insert"')).toBe(true);
  });

  test("Content selector scoping — nav/footer tags skipped", () => {
    const html =
      "<html><nav><h1>Nav</h1></nav><main><h1>Main</h1></main></html>";
    const result = injectHtmxShells(html, [blockFixture]);
    // Nav h1 should NOT have the shell wrapper
    const navMatch = result.match(/<nav>.*?<\/nav>/s);
    expect(navMatch).not.toBeNull();
    expect(navMatch![0].includes("mb-block")).toBe(false);
  });

  test("Multiple same-tag blocks get distinct IDs", () => {
    const html = "<main><h1>First</h1><h1>Second</h1></main>";
    const blocks: Block[] = [
      { tag: "h1", index: 0, position: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } },
      { tag: "h1", index: 1, position: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } } },
    ];
    const result = injectHtmxShells(html, blocks);
    expect(result.includes('data-block-id="h1-0"')).toBe(true);
    expect(result.includes('data-block-id="h1-1"')).toBe(true);
  });

  test("Uneditable banner injected correctly", () => {
    const html = "<html><head></head><body><p>hi</p></body></html>";
    const result = injectUneditableBanner(html);
    expect(result.includes("<script>")).toBe(true);
    expect(result.includes("No markdown source found")).toBe(true);
  });

  test("Banner idempotent — not double-injected", () => {
    const html = "<html><head></head><body><p>hi</p></body></html>";
    const first = injectUneditableBanner(html);
    const second = injectUneditableBanner(first);
    expect(second).toBe(first);
  });

  test("htmx shells include hx-get source endpoint and action bar", () => {
    const html = "<main><p>Paragraph</p></main>";
    const blocks: Block[] = [
      { tag: "p", index: 0, position: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } },
    ];
    const result = injectHtmxShells(html, blocks);
    expect(result.includes('hx-get="/source"')).toBe(true);
    expect(result.includes("class=\"mb-bar\"")).toBe(true);
  });

});

// ============================================================
// "Save Handler" tests
// ============================================================
describe("Save Handler", () => {
  // Shared temp directory per test (isolated via beforeEach)
  let tmpDir: string;

  function makeRequest(body: unknown): Request {
    return new Request("http://localhost/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-test-"));
  });

  test("Edit heading via POST /save — file updated", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);

    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ filepath, blockId: "h1-0", text: "Updated Title" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const updated = fs.readFileSync(filepath, "utf-8");
    expect(updated.includes("Updated Title")).toBe(true);
  });

  test("Frontmatter preserved after save", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);

    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    await handleSave(
      makeRequest({ filepath, blockId: "h1-0", text: "New" }),
      cfg,
      indexer,
    );
    const updated = fs.readFileSync(filepath, "utf-8");
    expect(updated.startsWith("---")).toBe(true);
    expect(updated.includes("title: Test Page")).toBe(true);
  });

  test("Nonexistent blockId — 400 response", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);

    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ filepath, blockId: "h99-0", text: "ghost" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(400);
  });

  test("Path traversal blocked — 403 response", async () => {
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ filepath: "../../etc/passwd", blockId: "p-0", text: "x" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(403);
  });

  test("Missing source file — 404 response", async () => {
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    // Ask for a path that is not in the index at all
    const res = await handleSave(
      makeRequest({ path: "/nonexistent/", blockId: "h1-0", text: "x" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(404);
  });

  // --- Insert tests ---

  test("insert block after heading", async () => {
    const src = "# My Heading\n\nThis is a paragraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    // Build index with annotated content so indexer can resolve path
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "insert", filepath, afterBlockId: "h1-0", tag: "h2", text: "New Section" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // h1 must still be first, then inserted h2, then p
    expect(clean.includes("# My Heading")).toBe(true);
    expect(clean.includes("## New Section")).toBe(true);
    const h1Pos = clean.indexOf("# My Heading");
    const h2Pos = clean.indexOf("## New Section");
    expect(h1Pos).toBeLessThan(h2Pos);

    // Verify all blocks have annotations
    const blocks = parseBlocks(clean);
    expect(blocks.map((b) => formatBlockId({ tag: b.tag, index: b.index }))).toEqual(["h1-0", "h2-0", "p-0"]);
    for (const block of blocks) {
      const id = formatBlockId({ tag: block.tag, index: block.index });
      expect(updated.includes(`<!-- markdown-blocks:${id} -->`)).toBe(true);
    }
  });

  // --- Delete tests ---

  test("delete heading removes it", async () => {
    const src = "# My Heading\n\nThis is a paragraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "delete", filepath, blockId: "h1-0" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // Heading should be gone
    expect(clean.includes("My Heading")).toBe(false);
    // Only paragraph remains
    const blocks = parseBlocks(clean);
    expect(blocks.length).toBe(1);
    expect(blocks[0].tag).toBe("p");
  });

  // --- Move tests ---

  test("move heading after paragraph", async () => {
    // Start with p, h1, h2 — move h1-0 before p-0 swaps them so heading comes first
    const src = "Some text.\n\n# First Heading\n\n## Second Heading\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    // Move h1-0 (currently after p) before p-0 — heading moves to front
    const res = await handleSave(
      makeRequest({ action: "move", filepath, blockId: "h1-0", beforeBlockId: "p-0" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // Order should be: h1, p, h2 (heading moved before paragraph)
    const blocks = parseBlocks(clean);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "p", "h2"]);
  });

  test("move heading to end", async () => {
    const src = "# First Heading\n\nSome text.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "move", filepath, blockId: "h1-0" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // Order should be: p, h1
    const blocks = parseBlocks(clean);
    expect(blocks.map((b) => b.tag)).toEqual(["p", "h1"]);
  });

  // --- Insert preserves block IDs (reindexing) ---

  test("insert reindexes subsequent blocks", async () => {
    const src = "# First\n\n# Second\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "insert", filepath, afterBlockId: "h1-0", tag: "h2", text: "Middle" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // Should be h1-0, h2-0, h1-1
    const blocks = parseBlocks(clean);
    expect(blocks.map((b) => formatBlockId({ tag: b.tag, index: b.index }))).toEqual(["h1-0", "h2-0", "h1-1"]);
  });

  // --- Missing required field returns 400 ---

  test("insert without tag returns 400", async () => {
    const src = "# Heading\n\nParagraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "insert", filepath, afterBlockId: "h1-0", text: "New" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(400);
  });

  test("move without blockId returns 400", async () => {
    const src = "# Heading\n\nParagraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeRequest({ action: "move", filepath, beforeBlockId: "p-0" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(400);
  });

  test("move block down within same parent", async () => {
    const src = "# First\n\n# Second\n\n# Third\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    // Move h1-0 (First) down — it should go between Second and Third
    const res = await handleSave(
      makeRequest({ action: "move", filepath, blockId: "h1-0", beforeBlockId: "h1-2" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);

    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    // Verify order: Second should come before First, First before Third
    const secondPos = clean.indexOf("# Second");
    const firstPos = clean.indexOf("# First");
    const thirdPos = clean.indexOf("# Third");
    expect(secondPos).toBeGreaterThan(-1);
    expect(firstPos).toBeGreaterThan(-1);
    expect(thirdPos).toBeGreaterThan(-1);
    expect(secondPos).toBeLessThan(firstPos);
    expect(firstPos).toBeLessThan(thirdPos);
  });
});

import { renderBlock, escapeHtml } from "../src/render.js";

// ============================================================
// "renderBlock" tests
// ============================================================
describe("renderBlock", () => {
  test("heading ATX depth 1", () => {
    expect(renderBlock("# Hello")).toBe("<h1>Hello</h1>");
  });

  test("heading depth 2", () => {
    expect(renderBlock("## Subtitle")).toBe("<h2>Subtitle</h2>");
  });

  test("paragraph", () => {
    expect(renderBlock("Some text.")).toBe("<p>Some text.</p>");
  });

  test("blockquote", () => {
    expect(renderBlock("> Quote")).toBe("<blockquote><p>Quote</p></blockquote>");
  });

  test("unordered list", () => {
    expect(renderBlock("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  test("ordered list", () => {
    expect(renderBlock("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  test("code block", () => {
    expect(renderBlock("```rust\nfn main() {}\n```")).toBe(
      '<pre><code class="language-rust">fn main() {}</code></pre>',
    );
  });

  test("inline emphasis", () => {
    expect(renderBlock("*em*")).toBe("<p><em>em</em></p>");
  });

  test("inline strong", () => {
    expect(renderBlock("**bold**")).toBe("<p><strong>bold</strong></p>");
  });

  test("inline code", () => {
    expect(renderBlock("`code`")).toBe("<p><code>code</code></p>");
  });

  test("escapeHtml works", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml('a & b')).toBe("a &amp; b");
  });
});

// ============================================================
// "Indexer" tests
// ============================================================
describe("Indexer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-index-"));
  });

  test("Zola preset resolves URLs correctly", () => {
    // Create Zola-style content tree
    fs.writeFileSync(path.join(tmpDir, "_index.md"), "# Home\n");
    fs.writeFileSync(path.join(tmpDir, "about.md"), "# About\n");
    fs.mkdirSync(path.join(tmpDir, "blog"));
    fs.writeFileSync(
      path.join(tmpDir, "blog", "post.md"),
      "# A Blog Post\n",
    );

    const cfg: Config = { contentDir: tmpDir, preset: "zola", trailingSlash: true };
    const map = buildIndex(cfg);

    expect(map.has("/")).toBe(true);
    expect(map.has("/about/")).toBe(true);
    expect(map.has("/blog/post/")).toBe(true);
  });

  test("pathMap override works", () => {
    const contentDir = path.join(tmpDir, "cm");
    fs.mkdirSync(contentDir);
    fs.writeFileSync(path.join(contentDir, "page.md"), "# Page\n");

    const overrideFile = path.join(tmpDir, "override-target.md");
    fs.writeFileSync(overrideFile, "# Override\n");

    const cfg: Config = {
      contentDir,
      preset: "generic",
      trailingSlash: true,
      pathMap: { "/page/": overrideFile },
    };

    const indexer = new Indexer(cfg);
    indexer.build();

    expect(indexer.resolve("/page/")).toBe(overrideFile);
  });
});

// ============================================================
// "moveBlockByDirection" tests
// ============================================================
describe("moveBlockByDirection", () => {
  test("move up — heading moves above paragraph", () => {
    const src = "Some text.\n\n# First Heading\n";
    // h1-0 is after p-0, moving it up should swap them
    const r = moveBlockByDirection(src, { tag: "h1", index: 0 }, "up");
    expect(r.success).toBe(true);
    const blocks = parseBlocks(r.result);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "p"]);
  });

  test("move down — paragraph moves below heading", () => {
    const src = "# First Heading\n\nSome text.\n\n# Second Heading\n";
    // p-0 is between h1-0 and h1-1, moving it down should put it after both headings
    const r = moveBlockByDirection(src, { tag: "p", index: 0 }, "down");
    expect(r.success).toBe(true);
    const blocks = parseBlocks(r.result);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "h1", "p"]);
  });

  test("move up at top — returns success false", () => {
    const src = "# First\n\n# Second\n";
    const r = moveBlockByDirection(src, { tag: "h1", index: 0 }, "up");
    expect(r.success).toBe(false);
    expect(r.result).toBe(src);
  });

  test("move down at bottom — returns success false", () => {
    const src = "# First\n\n# Second\n";
    const r = moveBlockByDirection(src, { tag: "h1", index: 1 }, "down");
    expect(r.success).toBe(false);
    expect(r.result).toBe(src);
  });

  test("move down in middle of three blocks", () => {
    const src = "# A\n\n# B\n\n# C\n";
    // Move h1-0 (A) down — should swap with B
    const r = moveBlockByDirection(src, { tag: "h1", index: 0 }, "down");
    expect(r.success).toBe(true);
    const blocks = parseBlocks(r.result);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "h1", "h1"]);
    // Check content order: B should come first now
    const clean = r.result;
    const aPos = clean.indexOf("# A");
    const bPos = clean.indexOf("# B");
    expect(bPos).toBeLessThan(aPos);
  });

  test("nonexistent blockId — returns success false", () => {
    const src = "# First\n";
    const r = moveBlockByDirection(src, { tag: "h99", index: 0 }, "up");
    expect(r.success).toBe(false);
  });
});

// ============================================================
// "HTMX Response" tests
// ============================================================
describe("HTMX Response", () => {
  let tmpDir: string;

  function makeHtmxRequest(body: unknown): Request {
    return new Request("http://localhost/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "HX-Request": "true",
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-htmx-"));
  });

  test("htmx edit returns text/html Content-Type", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ filepath, blockId: "h1-0", text: "Updated" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.includes("text/html")).toBe(true);
  });

  test("htmx edit response returns innerHTML content with .mb-content wrapper", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ filepath, blockId: "h1-0", text: "Updated" }),
      cfg,
      indexer,
    );
    const body = await res.text();
    // Save returns innerHTML (no outer mb-block div) so innerHTML swap into srcBlock works cleanly
    expect(body.includes("mb-content")).toBe(true);
    expect(body.includes("mb-bar")).toBe(false); // toolbar excluded to avoid duplication
    expect(body.includes("Updated")).toBe(true);
  });

  test("htmx delete returns empty string with text/html", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ action: "delete", filepath, blockId: "h1-0" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.includes("text/html")).toBe(true);
    const body = await res.text();
    expect(body).toBe("");
  });

  test("htmx move returns JSON success (DOM rearrangement is client-side)", async () => {
    const src = "# First\n\nSome text.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ action: "move", filepath, blockId: "h1-0", direction: "down" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("non-htmx request returns JSON (back compat)", async () => {
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, FIXTURE);
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    // No HX-Request header
    const req = new Request("http://localhost/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filepath, blockId: "h1-0", text: "Updated" }),
    });

    const res = await handleSave(req, cfg, indexer);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.includes("application/json")).toBe(true);
  });
  test("htmx edit with inline bold renders <strong>", async () => {
    const src = "# Heading\n\nSome text.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ filepath, blockId: "p-0", text: "**bold text**" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.includes("<strong>bold text</strong>")).toBe(true);
  });

  test("htmx edit with inline italic renders <em>", async () => {
    const src = "# Heading\n\nSome text.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ filepath, blockId: "p-0", text: "*italic text*" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.includes("<em>italic text</em>")).toBe(true);
  });

  test("htmx edit multiline preserves newlines", async () => {
    const src = "# Heading\n\nSome text.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSave(
      makeHtmxRequest({ filepath, blockId: "p-0", text: "Line one\nLine two\nLine three" }),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    // File should contain all three lines
    const updated = fs.readFileSync(filepath, "utf-8");
    const clean = deannotate(updated);
    expect(clean.includes("Line one")).toBe(true);
    expect(clean.includes("Line two")).toBe(true);
    expect(clean.includes("Line three")).toBe(true);
  });

});
// ============================================================
// "handleSource" tests
// ============================================================
describe("handleSource", () => {
  let tmpDir: string;

  function makeSourceRequest(blockId: string, pagePath: string): Request {
    return new Request(`http://localhost/source?blockId=${blockId}&path=${pagePath}`, {
      method: "GET",
      headers: { "HX-Request": "true" },
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-source-"));
  });

  test("returns textarea with raw heading markdown", async () => {
    const src = "# My Heading\n\nSome paragraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSource(
      makeSourceRequest("h1-0", "/page/"),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.includes("text/html")).toBe(true);
    const body = await res.text();
    expect(body.includes("<textarea")).toBe(true);
    expect(body.includes("class=\"mb-source\"")).toBe(true);
    // The heading markdown should be in the textarea (may be HTML-escaped)
    expect(body.includes("&lt;!--") || body.includes("# My Heading")).toBe(true);
  });

  test("returns 404 for nonexistent block", async () => {
    const src = "# Heading\n\nParagraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSource(
      makeSourceRequest("h99-0", "/page/"),
      cfg,
      indexer,
    );
    expect(res.status).toBe(404);
  });

  test("returns 403 for path traversal", async () => {
    const src = "# Heading\n\nParagraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSource(
      makeSourceRequest("h1-0", "/../../etc/passwd"),
      cfg,
      indexer,
    );
    expect(res.status).toBe(404); // path not in index map, so indexer.resolve() returns null
  });

  test("returns textarea with raw paragraph markdown", async () => {
    const src = "# Heading\n\nSome paragraph text here.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSource(
      makeSourceRequest("p-0", "/page/"),
      cfg,
      indexer,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.includes("<textarea")).toBe(true);
  });

  test("returns textarea with autofocus and action bar", async () => {
    const src = "# Heading\n\nParagraph.\n";
    const filepath = path.join(tmpDir, "page.md");
    fs.writeFileSync(filepath, annotate(src));
    const cfg: Config = { contentDir: tmpDir, preset: "generic", trailingSlash: true };
    const indexer = new Indexer(cfg);
    indexer.build();

    const res = await handleSource(
      makeSourceRequest("h1-0", "/page/"),
      cfg,
      indexer,
    );
    const body = await res.text();
    expect(body.includes('class="mb-source"')).toBe(true);
    expect(body.includes('autofocus')).toBe(true);
    // Action bar is NOT included in /source response; it's cloned from shell
    expect(body.includes('class="mb-bar"')).toBe(false);
  });
});
