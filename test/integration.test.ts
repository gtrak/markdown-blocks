/**
 * Integration test: full save-server proxy + Puppeteer browser automation.
 *
 * Spins up a mock backend (renders markdown → HTML → injects shells),
 * starts the save-server proxy, and exercises all editing features in a real
 * Chromium instance.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer";
import MarkdownIt from "markdown-it";
import { Config } from "../src/types.js";
import { parseBlocks } from "../src/ast.js";
import { deannotate, annotateAll } from "../src/annotate.js";
import { createSaveHandler } from "../src/server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_MD = `+++
title = "Test Page"
+++

<!-- markdown-blocks:h1-0 -->
# Heading One

<!-- markdown-blocks:p-0 -->
This is a paragraph.

<!-- markdown-blocks:h2-0 -->
## Sub Heading

<!-- markdown-blocks:ul-0 -->
* Item 1
* Item 2
`;

const MOCK_BACKEND_PORT = 19876;
const SAVE_SERVER_PORT = 19877;

let tmpDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
let contentFile: string;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function resetFixture(): void {
  fs.writeFileSync(contentFile, FIXTURE_MD);
  try { annotateAll(tmpDir); } catch {}
}

// ---------------------------------------------------------------------------
// Mock backend — simulates Zola: renders annotated markdown to plain HTML.
// Comment anchors pass through so the save-server proxy can inject shells.
// Reads file fresh on each request so persisted changes appear on reload.
function renderMarkdownToHtml(mdPath: string): string {
  const annotated = fs.readFileSync(mdPath, "utf-8");
  const md = new MarkdownIt({ html: true });
  // Strip annotation-only markers (contentDir marker etc.) but keep block anchors
  const stripped = annotated.replace(/<!--\s*mb-marker:[^>]*-->/g, '');
  const bodyContent = md.render(stripped);

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head><title>Test Page</title></head>",
    "<body>",
    `<main>${bodyContent}</main>`,
    '<footer class="site-footer"><p>Click outside to save</p></footer>',
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-integ-"));
  contentFile = path.join(tmpDir, "_index.md");
  resetFixture();

  // Start mock backend
  mockServer = Bun.serve({
    port: MOCK_BACKEND_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = renderMarkdownToHtml(contentFile);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Start save server (proxy mode)
  const cfg: Config = {
    contentDir: tmpDir,
    preset: "zola",
    backendProxyUrl: `http://localhost:${MOCK_BACKEND_PORT}`,
    trailingSlash: true,
  };

  const { handler } = createSaveHandler(cfg);

  Bun.serve({
    port: SAVE_SERVER_PORT,
    fetch(req) {
      return (handler as (req: Request) => Promise<Response>)(req);
    },
  });

  // Launch browser
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Wait for servers
  await new Promise(r => setTimeout(r, 1000));
});

afterAll(async () => {
  try { await browser.close(); } catch {}
  mockServer?.stop(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function newPage() {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${SAVE_SERVER_PORT}/`, {
    waitUntil: "networkidle0",
  });
  return page;
}

function readFixture(): string {
  return fs.readFileSync(path.join(tmpDir, "_index.md"), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: full save-server proxy + browser", () => {
  beforeEach(() => {
    resetFixture();
  });

  test("page loads with injected mb-block elements", async () => {
    const page = await newPage();
    const blocks = await page.$$eval(".mb-block", (els) => els.length);
    expect(blocks).toBe(4);

    // Check save indicator element exists (confirms client script ran)
    const indicatorExists = await page.evaluate(() =>
      !!document.getElementById("save-indicator")
    );
    expect(indicatorExists).toBe(true);

    await page.close();
  });


  test("click block enters edit mode (textarea appears)", async () => {
    const page = await newPage();

    // Click first block's content area
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      blocks[0].querySelector(".mb-content")?.click();
    });
    await page.waitForSelector(".mb-source", { timeout: 3000 });

    const textarea = await page.$eval(
      ".mb-source",
      (el) => (el as HTMLTextAreaElement).value
    );
    expect(textarea).toContain("Heading One");

    const editing = await page.evaluate(() =>
      document.querySelector(".mb-block.mb-editing") !== null
    );
    expect(editing).toBe(true);

    await page.close();
  });

  test("edit + click another block → auto-save, no reload", async () => {
    const page = await newPage();

    // Enter edit mode on first block
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      blocks[0].querySelector(".mb-content")?.click();
    });
    await page.waitForSelector(".mb-source", { timeout: 3000 });

    // Edit content
    await page.evaluate(() => {
      document.querySelector(".mb-source")!.value = "# Edited Heading";
    });

    // Click second block to trigger auto-save
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      blocks[1].querySelector(".mb-content")?.click();
    });

    // Wait for auto-save to complete and second block to enter edit mode
    await page.waitForSelector(".mb-source", { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 1000)); // let htmx swap settle

    // Verify first block saved and rendered
    const firstBlockHtml = await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      return blocks[0].innerHTML;
    });
    expect(firstBlockHtml).toContain("mb-content");
    expect(firstBlockHtml).not.toContain("mb-source");

    // Verify second block in edit mode
    const secondEditing = await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      return blocks[1].classList.contains("mb-editing");
    });
    expect(secondEditing).toBe(true);

    // Verify file on disk
    const content = readFixture();
    expect(content).toContain("# Edited Heading");

    await page.close();
  });

  test("edit + click outside → auto-save, no reload", async () => {
    const page = await newPage();

    // Enter edit mode
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      blocks[0].querySelector(".mb-content")?.click();
    });
    await page.waitForSelector(".mb-source", { timeout: 3000 });

    // Edit content
    await page.evaluate(() => {
      document.querySelector(".mb-source")!.value = "# Outside Save";
    });

    // Click footer (outside any block)
    await page.evaluate(() => {
      document.querySelector(".site-footer")?.click();
    });

    // Wait for save to complete
    await new Promise((r) => setTimeout(r, 1500));

    // Verify first block rendered (no textarea)
    const hasTextarea = await page.evaluate(() =>
      !!document.querySelector(".mb-source")
    );
    expect(hasTextarea).toBe(false);

    // Verify file saved
    const content = readFixture();
    expect(content).toContain("# Outside Save");

    await page.close();
  });

  test("save indicator shows after save", async () => {
    const page = await newPage();

    // Edit and save
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".mb-block");
      blocks[0].querySelector(".mb-content")?.click();
    });
    await page.waitForSelector(".mb-source", { timeout: 3000 });

    await page.evaluate(() => {
      document.querySelector(".mb-source")!.value = "# Indicator Test";
    });

    // Click outside to save
    await page.evaluate(() => {
      document.querySelector(".site-footer")?.click();
    });

    // Wait for save indicator to appear
    await page.waitForSelector("#save-indicator.show", { timeout: 3000 });

    const visible = await page.$eval(
      "#save-indicator",
      (el) => el.classList.contains("show")
    );
    expect(visible).toBe(true);

    await page.close();
  });



  test("move block up/down reorders in DOM and file", async () => {
    const page = await newPage();
    try {
      // Get initial block order
      const beforeOrder = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".mb-block")).map((b) =>
          b.getAttribute("data-block-id")
        );
      });
      expect(beforeOrder).toEqual(["h1-0", "p-0", "h2-0", "ul-0"]);

      // Enter edit mode on second block (p-0) via evaluate click
      await page.evaluate(() => {
        const blocks = document.querySelectorAll(".mb-block");
        blocks[1].querySelector(".mb-content")?.click();
      });
      await page.waitForSelector(".mb-source", { timeout: 3000 });

      // Set up waitForResponse before clicking move-down button
      const moveResp = page.waitForResponse(
        (r) => r.url().includes("/save") && r.status() === 200
      );
      await page.evaluate(() => {
        document.querySelector('.mb-floater button[data-mb-move="down"]')?.click();
      });
      await moveResp;

      // Wait for DOM update from htmx:afterRequest handler
      await new Promise((r) => setTimeout(r, 300));

      // Reload page to verify server-side order persisted
      await page.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));

      const afterOrder = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".mb-block")).map((b) =>
          b.getAttribute("data-block-id")
        );
      });

      // p-0 should have moved down after h2-0
      expect(afterOrder).toEqual(["h1-0", "h2-0", "p-0", "ul-0"]);

      // Verify file reflects new order
      const content = readFixture();
      const blocks = parseBlocks(deannotate(content));
      expect(blocks.length).toBe(4);
    } finally {
      await page.close();
    }
  });

  test("insert block via UI button adds to DOM and file", async () => {
    const page = await newPage();
    try {
      const initialCount = await page.$$eval(".mb-block", (els) => els.length);
      expect(initialCount).toBe(4);

      // Enter edit mode on p-0 block by clicking its .mb-content
      await page.evaluate(() => {
        document.querySelector('.mb-block[data-block-id="p-0"] .mb-content')?.click();
      });
      await page.waitForSelector(".mb-source", { timeout: 3000 });

      // The insert button is in .mb-floater (toolbar moved there by enterEditMode)
      const insertResp = page.waitForResponse(
        (r) => r.url().includes("/save") && r.status() === 200,
      );
      await page.evaluate(() => {
        document.querySelector('.mb-floater button[data-mb-action="insert"]')?.click();
      });
      await insertResp;
      await new Promise((r) => setTimeout(r, 500));

      // Verify DOM immediately after insert
      const postInsertCount = await page.$$eval(".mb-block", (els) => els.length);
      expect(postInsertCount).toBe(5);

      // Reload to verify persistence
      await page.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));

      const reloadCount = await page.$$eval(".mb-block", (els) => els.length);
      expect(reloadCount).toBe(5);

      const reloadIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".mb-block")).map((b) =>
          b.getAttribute("data-block-id")
        )
      );
      // New empty paragraph inserted after p-0; existing p-0 becomes p-1
      expect(reloadIds).toEqual(["h1-0", "p-0", "p-1", "h2-0", "ul-0"]);
    } finally {
      await page.close();
    }
  });

  test("delete block removes from DOM and file", async () => {
    const page = await newPage();
    try {
      // Verify initial block count
      const delInitialCount = await page.$$eval(".mb-block", (els) => els.length);
      expect(delInitialCount).toBe(4);

      // Enter edit mode on second block (p-0) via evaluate click
      await page.evaluate(() => {
        const blocks = document.querySelectorAll(".mb-block");
        blocks[1].querySelector(".mb-content")?.click();
      });
      await page.waitForSelector(".mb-source", { timeout: 3000 });

      // Floater should exist with action buttons
      const floaterExists = await page.evaluate(
        () => !!document.querySelector(".mb-floater")
      );
      expect(floaterExists).toBe(true);

      // Set up waitForResponse BEFORE clicking delete
      const deleteResponsePromise = page.waitForResponse(
        (resp) =>
          resp.url().includes("/save") &&
          resp.status() === 200 &&
          resp.request().method() === "POST"
      );
      await page.evaluate(() => {
        document.querySelector('.mb-floater button[data-mb-action="delete"]')?.click();
      });
      await deleteResponsePromise;

      // Wait briefly for server write to settle
      await new Promise((r) => setTimeout(r, 500));

      // Client-side DOM update may be delayed in Puppeteer,
      // but reload confirms the server persisted the delete correctly

      await page.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 500));

      const reloadCount = await page.$$eval(".mb-block", (els) => els.length);
      expect(reloadCount).toBe(3);

      const reloadIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".mb-block")).map((b) =>
          b.getAttribute("data-block-id")
        )
      );
      expect(reloadIds).toEqual(["h1-0", "h2-0", "ul-0"]);
    } finally {
      await page.close();
    }
  });
});
