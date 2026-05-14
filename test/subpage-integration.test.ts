/**
 * Integration test: verify subpage save operations target the correct markdown
 * file, NOT `_index.md`. This is a regression test for the bug where client-side
 * JS hardcoded `path: '/'` for all move/delete/insert actions.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer";
import MarkdownIt from "markdown-it";
import { Config } from "../src/types.js";
import { annotateAll, deannotateAll } from "../src/annotate.js";
import { Indexer } from "../src/indexer.js";
import { handleSave } from "../src/save.js";

// ---------------------------------------------------------------------------
// Fixtures — NO pre-existing block IDs; annotateAll adds them.
// ---------------------------------------------------------------------------

const ROOT_MD = `+++
title = "Home"
+++

# Home Page

Root paragraph.
`;

const SUBPAGE_MD = `+++
title = "How It Works"
+++

# How It Works

Subpage paragraph.

## Details

More details here.
`;

const MOCK_BACKEND_PORT = 19878;
const SAVE_SERVER_PORT = 19879;

let tmpDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let saveServer: ReturnType<typeof Bun.serve>;
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
let saveConfig: Config;
let idx: Indexer;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFile(relPath: string, content: string): void {
  const filePath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
}

function renderMarkdownToHtml(mdPath: string): string {
  const annotated = fs.readFileSync(mdPath, "utf-8");
  const md = new MarkdownIt({ html: true });
  const stripped = annotated.replace(/<!--\s*mb-marker:[^>]*-->/g, "");
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

/** Reset fixture files and rebuild index so block IDs are fresh. */
function resetFixture(rebuildIndex?: boolean): void {
  writeFile("_index.md", ROOT_MD);
  writeFile("how-it-works/_index.md", SUBPAGE_MD);
  try { deannotateAll(tmpDir); } catch {}
  annotateAll(tmpDir);
  if (rebuildIndex && idx) {
    idx.build();
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-subpage-"));

  // Write initial fixtures (before index exists, so skip rebuild)
  writeFile("_index.md", ROOT_MD);
  writeFile("how-it-works/_index.md", SUBPAGE_MD);
  try { deannotateAll(tmpDir); } catch {}
  annotateAll(tmpDir);

  saveConfig = {
    contentDir: tmpDir,
    preset: "zola",
    backendProxyUrl: `http://localhost:${MOCK_BACKEND_PORT}`,
    trailingSlash: true,
  };

  idx = new Indexer(saveConfig);
  idx.build();

  // Verify indexer maps /how-it-works/ to subpage file
  const subpagePath = idx.resolve("/how-it-works/");
  expect(subpagePath).toBeTruthy();
  expect(subpagePath!.includes("how-it-works")).toBe(true);

  // Mock backend — serves both root and subpages by reading from content dir
  mockServer = Bun.serve({
    port: MOCK_BACKEND_PORT,
    fetch(req) {
      const url = new URL(req.url);
      let filePath;

      if (url.pathname === "/") {
        filePath = path.join(tmpDir, "_index.md");
      } else {
        const dirPath = url.pathname.replace(/^\//, "").replace(/\/$/, "");
        filePath = path.join(tmpDir, dirPath, "_index.md");
      }

      if (fs.existsSync(filePath)) {
        const html = renderMarkdownToHtml(filePath);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Save server (proxy mode) — create fresh handler so deannotateAll/annotateAll
  // already ran on startup
  const { createSaveHandler } = await import("../src/server.js");
  // We can't call createSaveHandler again because it does deannotateAll/annotateAll
  // and sets up watchers. Instead, use the raw handleSave directly for tests.
  // For puppeteer tests, we need a real server — but to avoid double-annotate,
  // just write a simple handler.

  saveServer = Bun.serve({
    port: SAVE_SERVER_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/mb-client.js") {
        return new Response("", { headers: { "Content-Type": "text/javascript" } });
      }

      if (url.pathname === "/save" && req.method === "POST") {
        // Fresh index build in case file changed
        idx.build();
        return handleSave(req, saveConfig, idx);
      }

      if (url.pathname === "/source") {
        const { handleSource } = require("../src/save.js");
        return handleSource(req, saveConfig, idx);
      }

      // Proxy to backend for page loads
      return fetch(`http://localhost:${MOCK_BACKEND_PORT}${url.pathname}${url.search}`, {
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: req.method !== "GET" ? req.body : undefined,
        redirect: "manual",
      });
    },
  });

  // Launch browser
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  await new Promise((r) => setTimeout(r, 1000));
});

afterAll(async () => {
  try { await browser.close(); } catch {}
  mockServer?.stop(true);
  saveServer?.stop(true);
});

// ---------------------------------------------------------------------------
// Tests: subpage save operations target correct file via handleSave directly
// ---------------------------------------------------------------------------

describe("Subpage saves target correct markdown file", () => {
  test("delete on subpage modifies SUBPAGE file, not _index.md", async () => {
    // Reset to ensure clean state
    resetFixture();

    // Read the annotated subpage to get actual block IDs
    const subpageContent = readFile("how-it-works/_index.md");
    expect(subpageContent).toContain("# How It Works");

    // Build delete request targeting subpage first heading (h1-0)
    const body = new URLSearchParams({
      action: "delete",
      blockId: "h1-0",
      path: "/how-it-works/",
    });

    const response = await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      saveConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Verify subpage file was modified — heading should be gone
    const afterSubpage = readFile("how-it-works/_index.md");
    expect(afterSubpage).not.toContain("# How It Works");

    // Verify root file was NOT touched
    const rootContent = readFile("_index.md");
    expect(rootContent).toContain("# Home Page");
  });

  test("delete on subpage does NOT modify _index.md (root)", async () => {
    resetFixture();

    const beforeRoot = readFile("_index.md");
    expect(beforeRoot).toContain("# Home Page");

    // Delete heading from SUBPAGE
    const body = new URLSearchParams({
      action: "delete",
      blockId: "h1-0",
      path: "/how-it-works/",
    });

    const response = await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      saveConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Root file should be unchanged
    const afterRoot = readFile("_index.md");
    expect(afterRoot).toContain("# Home Page");
  });

  test("edit on subpage targets correct file", async () => {
    resetFixture();

    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/how-it-works/",
      text: "# Completely Rewritten Heading",
    });

    const response = await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      saveConfig,
      idx
    );

    expect(response.status).toBe(200);

    const subpageContent = readFile("how-it-works/_index.md");
    expect(subpageContent).toContain("# Completely Rewritten Heading");

    const rootContent = readFile("_index.md");
    expect(rootContent).not.toContain("# Completely Rewritten Heading");
  });

  test("move on subpage targets correct file", async () => {
    resetFixture();

    // Move p-0 down on subpage
    const body = new URLSearchParams({
      action: "move",
      blockId: "p-0",
      path: "/how-it-works/",
      direction: "down",
    });

    const response = await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      saveConfig,
      idx
    );

    expect(response.status).toBe(200);

    const subpageContent = readFile("how-it-works/_index.md");
    // p-0 should be after h2-0 now
    const p0Pos = subpageContent.indexOf("markdown-blocks:p-0");
    const h2Pos = subpageContent.indexOf("markdown-blocks:h2-0");
    expect(h2Pos).toBeLessThan(p0Pos);

    const rootContent = readFile("_index.md");
    expect(rootContent).toContain("# Home Page");
  });

  test("insert on subpage targets correct file", async () => {
    resetFixture();

    const body = new URLSearchParams({
      action: "insert",
      afterBlockId: "h1-0",
      path: "/how-it-works/",
      tag: "p",
      text: "Inserted paragraph here.",
    });

    const response = await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      saveConfig,
      idx
    );

    expect(response.status).toBe(200);

    const subpageContent = readFile("how-it-works/_index.md");
    expect(subpageContent).toContain("Inserted paragraph here.");

    const rootContent = readFile("_index.md");
    expect(rootContent).not.toContain("Inserted paragraph here.");
  });
});
