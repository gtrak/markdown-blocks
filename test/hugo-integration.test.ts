/**
 * Integration test: Hugo-specific URL resolution and save operations.
 *
 * Simulates a Hugo site structure with content/blog/ section pages and
 * verifies that the Hugo preset correctly maps URLs to source files,
 * and that save operations target the right markdown files.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Config } from "../src/types.js";
import { annotateAll, deannotateAll, deannotate } from "../src/annotate.js";
import { Indexer } from "../src/indexer.js";
import { handleSave } from "../src/save.js";

// ---------------------------------------------------------------------------
// Hugo-style fixtures
// ---------------------------------------------------------------------------

const HUGO_HOME_MD = `---
title: "Home"
date: 2024-01-01
---

# Welcome to My Blog

This is the home page.

## Recent Posts

Check out my latest articles below.
`;

const BLOG_SECTION_MD = `---
title: "Blog Section"
description: "My blog posts"
---

# Blog

Welcome to the blog section.

## About This Blog

I write about technology and code.
`;

const POST_MD = `---
title: "First Post"
date: 2024-06-15
url: "/posts/my-first-post/"
---

# My First Post

This is the content of my first blog post.

## Introduction

Hello world!

## Conclusion

Thanks for reading.
`;

// ---------------------------------------------------------------------------
// Test fixtures setup
// ---------------------------------------------------------------------------

const HUGO_BACKEND_PORT = 19880;
const HUGO_SAVE_PORT = 19881;

let tmpDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let saveServer: ReturnType<typeof Bun.serve>;
let hugoConfig: Config;
let idx: Indexer;

function writeFile(relPath: string, content: string): void {
  const filePath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, relPath), "utf-8");
}

function resetFixture(): void {
  writeFile("_index.md", HUGO_HOME_MD);
  writeFile("blog/_index.md", BLOG_SECTION_MD);
  writeFile("blog/my-first-post.md", POST_MD);
  try { deannotateAll(tmpDir); } catch {}
  annotateAll(tmpDir);
  idx.build();
}

// ---------------------------------------------------------------------------
// Hugo HTML renderer — simulates how Hugo renders markdown content to HTML
// with HTML comments passing through.
// ---------------------------------------------------------------------------

function renderHugoHtml(mdPath: string): string {
  const content = fs.readFileSync(mdPath, "utf-8");
  
  // Simulate Goldmark rendering (markdown → HTML)
  // In a real Hugo setup you'd use the Goldmark library; here we just
  // strip annotation markers and pass comments through.
  const stripped = content.replace(/<!--\s*mb-marker:[^>]*-->/g, "");
  
  // Simple markdown-to-HTML conversion for testing (not production)
  let html = stripped;
  // Remove frontmatter (Hugo handles this server-side)
  html = html.replace(/^\n---[\s\S]+?---\n/, "");
  // Convert headings
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // Wrap paragraphs
  html = html.replace(/^(.+)$/gm, (line) => {
    if (!line.startsWith("<")) return `<p>${line}</p>`;
    return line;
  });

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><title>Hugo Site</title></head>',
    '<body>',
    `<main class="content">${html}</main>`,
    '<footer class="site-footer"><p>Hugo-powered site</p></footer>',
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-hugo-"));

  // Write initial fixtures
  writeFile("_index.md", HUGO_HOME_MD);
  writeFile("blog/_index.md", BLOG_SECTION_MD);
  writeFile("blog/my-first-post.md", POST_MD);
  try { deannotateAll(tmpDir); } catch {}
  annotateAll(tmpDir);

  hugoConfig = {
    contentDir: tmpDir,
    preset: "hugo",
    trailingSlash: true,
  };

  idx = new Indexer(hugoConfig);
  idx.build();

  // Verify Hugo indexer maps URLs correctly
  const homePath = idx.resolve("/");
  expect(homePath).toBeTruthy();
  expect(homePath!.includes("_index.md")).toBe(true);

  const blogPath = idx.resolve("/blog/");
  expect(blogPath).toBeTruthy();
  expect(blogPath!.includes("blog/_index.md")).toBe(true);

  // Mock backend — serves both root and subpages
  mockServer = Bun.serve({
    port: HUGO_BACKEND_PORT,
    fetch(req) {
      const url = new URL(req.url);
      
      let filePath;
      if (url.pathname === "/") {
        filePath = path.join(tmpDir, "_index.md");
      } else {
        // Hugo-style resolution: /blog/ → blog/_index.md, /blog/post/ → blog/post.md
        const dirPath = url.pathname.replace(/^\//, "").replace(/\/$/, "");
        filePath = path.join(tmpDir, dirPath + ".md");
        
        if (!fs.existsSync(filePath)) {
          // Try _index.md for section pages
          filePath = path.join(tmpDir, dirPath, "_index.md");
        }
      }

      if (fs.existsSync(filePath)) {
        const html = renderHugoHtml(filePath);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Save server
  saveServer = Bun.serve({
    port: HUGO_SAVE_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/mb-client.js") {
        return new Response("", { headers: { "Content-Type": "text/javascript" } });
      }

      if (url.pathname === "/save" && req.method === "POST") {
        idx.build(); // Rebuild index on each save
        return handleSave(req, hugoConfig, idx);
      }

      // Proxy to backend
      return fetch(`http://localhost:${HUGO_BACKEND_PORT}${url.pathname}${url.search}`, {
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body: req.method !== "GET" ? req.body : undefined,
        redirect: "manual",
      });
    },
  });
});

afterAll(() => {
  mockServer?.stop(true);
  saveServer?.stop(true);
});

// ---------------------------------------------------------------------------
// Tests: Hugo-specific indexer resolution
// ---------------------------------------------------------------------------

describe("Hugo preset — indexer URL resolution", () => {
  test("root _index.md resolves to /", () => {
    const homePath = idx.resolve("/");
    expect(homePath).toBeTruthy();
    expect(homePath!.endsWith("_index.md")).toBe(true);
    expect(homePath!.includes("blog")).toBe(false);
  });

  test("/blog/ resolves to blog/_index.md", () => {
    const blogPath = idx.resolve("/blog/");
    expect(blogPath).toBeTruthy();
    expect(blogPath!.includes("blog/_index.md")).toBe(true);
  });

  test("post with frontmatter url override uses that URL", () => {
    const postPath = idx.resolve("/posts/my-first-post/");
    expect(postPath).toBeTruthy();
    expect(postPath!.includes("blog/my-first-post.md")).toBe(true);
  });

  test("blog/_index.md does NOT resolve to /blog/my-first-post/", () => {
    const blogIndexPath = idx.resolve("/blog/");
    expect(blogIndexPath).toBeTruthy();
    // Blog index and post should be different files
    const postPath = idx.resolve("/posts/my-first-post/");
    expect(postPath).toBeTruthy();
    expect(blogIndexPath).not.toBe(postPath);
  });
});

// ---------------------------------------------------------------------------
// Tests: Hugo save operations with correct URL targeting
// ---------------------------------------------------------------------------

describe("Hugo preset — save operations", () => {
  beforeEach(() => {
    resetFixture();
  });

  test("edit home page modifies only _index.md", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/",
      text: "# Welcome to My Hugo Blog",
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
      hugoConfig,
      idx
    );

    expect(response.status).toBe(200);
    expect(readFile("_index.md")).toContain("Welcome to My Hugo Blog");
    // Blog section should be unchanged
    expect(readFile("blog/_index.md")).toContain("Welcome to the blog section");
  });

  test("delete on blog section modifies blog/_index.md only", async () => {
    const body = new URLSearchParams({
      action: "delete",
      blockId: "h2-0",
      path: "/blog/",
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
      hugoConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Blog section should have h2 removed
    const blogContent = readFile("blog/_index.md");
    expect(blogContent).not.toContain("## About This Blog");
    
    // Home page should be unchanged
    expect(readFile("_index.md")).toContain("# Welcome to My Blog");
  });

  test("move on post targets correct file (url override respected)", async () => {
    const body = new URLSearchParams({
      action: "move",
      blockId: "h2-0",
      path: "/posts/my-first-post/",
      direction: "up",
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
      hugoConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Verify home page not affected
    const homeContent = readFile("_index.md");
    expect(homeContent).toContain("Welcome to My Blog");
  });

  test("insert on home page targets root file", async () => {
    const body = new URLSearchParams({
      action: "insert",
      afterBlockId: "h1-0",
      path: "/",
      tag: "p",
      text: "New paragraph on home.",
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
      hugoConfig,
      idx
    );

    expect(response.status).toBe(200);
    expect(readFile("_index.md")).toContain("New paragraph on home.");
  });

  test("save to nonexistent path returns 404", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/nonexistent-page/",
      text: "# Should not work",
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
      hugoConfig,
      idx
    );

    expect(response.status).toBe(404);
  });

  test("YAML frontmatter preserved after Hugo save", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/blog/",
      text: "# Updated Blog Section",
    });

    await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      }),
      hugoConfig,
      idx
    );

    const content = readFile("blog/_index.md");
    expect(content).toContain("---");
    expect(content).toContain("title: \"Blog Section\"");
    expect(content).toContain("Updated Blog Section");
  });
});
