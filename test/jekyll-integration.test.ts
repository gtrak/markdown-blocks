/**
 * Integration test: Jekyll-specific URL resolution and save operations.
 *
 * Simulates a Jekyll site structure with _posts/ date-based posts and
 * regular pages, verifies that the Jekyll preset correctly maps URLs
 * to source files, and that save operations target the right markdown files.
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
// Jekyll-style fixtures
// ---------------------------------------------------------------------------

const HOME_MD = `---
title: "Home"
date: 2024-01-01
layout: home
---

# Welcome to My Blog

This is the home page.

## Recent Posts

Check out my latest articles below.
`;

const ABOUT_PAGE_MD = `---
title: "About Me"
layout: page
permalink: /about/
---

# About Me

I am a writer and developer.

## Background

I have been writing since forever.
`;

const POST_JANUARY_MD = `---
title: "First Post"
date: 2024-01-15
category: tech
tags: [hello, world]
---

# My First Post

This is the content of my first blog post.

## Introduction

Hello world!

## Conclusion

Thanks for reading.
`;

const POST_JUNE_MD = `---
title: "Midyear Update"
date: 2024-06-01
category: personal
tags: [update, midyear]
---

# Midyear Update

A progress report on my plans for the year.

## Goals Completed

So far I've managed to keep this blog alive.

## Goals Remaining

Lots more to do before December.
`;

// ---------------------------------------------------------------------------
// Test fixtures setup
// ---------------------------------------------------------------------------

const JEKYLL_BACKEND_PORT = 19890;
const JEKYLL_SAVE_PORT = 19891;

let tmpDir: string;
let mockServer: ReturnType<typeof Bun.serve>;
let saveServer: ReturnType<typeof Bun.serve>;
let jekyllConfig: Config;
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
  writeFile("_index.md", HOME_MD);
  writeFile("about.md", ABOUT_PAGE_MD);
  writeFile("_posts/2024-01-15-first-post.md", POST_JANUARY_MD);
  writeFile("_posts/2024-06-01-midyear-update.md", POST_JUNE_MD);
  try { deannotateAll(tmpDir); } catch {}
  annotateAll(tmpDir);
  idx.build();
}

// ---------------------------------------------------------------------------
// Jekyll HTML renderer — simulates how Jekyll renders markdown content to HTML.
// Jekyll typically uses kramdown with GFM input.
// ---------------------------------------------------------------------------

function renderJekyllHtml(mdPath: string): string {
  const content = fs.readFileSync(mdPath, "utf-8");

  // Simulate Jekyll rendering (markdown → HTML)
  // Strip annotation markers, keep comments through
  const stripped = content.replace(/<!--\s*mb-marker:[^>]*-->/g, "");

  // Simple markdown-to-HTML conversion for testing
  let html = stripped;
  // Remove frontmatter (Jekyll handles this server-side)
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
    '<head><title>Jekyll Site</title></head>',
    '<body>',
    `<main class="content">${html}</main>`,
    '<footer class="site-footer"><p>Jekyll-powered site</p></footer>',
    "</body></html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-jekyll-"));

  jekyllConfig = {
    contentDir: tmpDir,
    preset: "jekyll",
    trailingSlash: true,
  };

  idx = new Indexer(jekyllConfig);

  // Write initial fixtures (resetFixture uses idx.build())
  resetFixture();

  // Verify Jekyll indexer maps URLs correctly
  const homePath = idx.resolve("/");
  expect(homePath).toBeTruthy();
  expect(homePath!.includes("_index.md")).toBe(true);

  const postPath = idx.resolve("/blog/2024/01/15/first-post/");
  expect(postPath).toBeTruthy();
  expect(postPath!.includes("_posts/2024-01-15-first-post.md")).toBe(true);

  // Mock backend — serves root and resolved pages
  mockServer = Bun.serve({
    port: JEKYLL_BACKEND_PORT,
    fetch(req) {
      const url = new URL(req.url);

      let filePath;
      if (url.pathname === "/") {
        filePath = path.join(tmpDir, "_index.md");
      } else {
        // Use indexer to resolve URL → file path
        const resolvedPath = idx.resolve(url.pathname);
        if (resolvedPath) {
          filePath = resolvedPath;
        } else {
          // Fallback: try direct mapping
          const dirPath = url.pathname.replace(/^\//, "").replace(/\/$/, "");
          filePath = path.join(tmpDir, dirPath + ".md");
        }
      }

      if (fs.existsSync(filePath)) {
        const html = renderJekyllHtml(filePath);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Save server
  saveServer = Bun.serve({
    port: JEKYLL_SAVE_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/mb-client.js") {
        return new Response("", { headers: { "Content-Type": "text/javascript" } });
      }

      if (url.pathname === "/save" && req.method === "POST") {
        idx.build(); // Rebuild index on each save
        return handleSave(req, jekyllConfig, idx);
      }

      // Proxy to backend
      return fetch(`http://localhost:${JEKYLL_BACKEND_PORT}${url.pathname}${url.search}`, {
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
// Tests: Jekyll-specific indexer resolution
// ---------------------------------------------------------------------------

describe("Jekyll preset — indexer URL resolution", () => {
  test("root _index.md resolves to /", () => {
    const homePath = idx.resolve("/");
    expect(homePath).toBeTruthy();
    expect(homePath!.endsWith("_index.md")).toBe(true);
    expect(homePath!.includes("blog")).toBe(false);
  });

  test("/about/ resolves to about.md", () => {
    const aboutPath = idx.resolve("/about/");
    expect(aboutPath).toBeTruthy();
    expect(aboutPath!.includes("about.md")).toBe(true);
  });

  test("Jekyll date-based post URL resolves to _posts file", () => {
    const postPath = idx.resolve("/blog/2024/01/15/first-post/");
    expect(postPath).toBeTruthy();
    expect(postPath!.includes("_posts/2024-01-15-first-post.md")).toBe(true);
  });

  test("June post URL resolves to correct _posts file", () => {
    const postPath = idx.resolve("/blog/2024/06/01/midyear-update/");
    expect(postPath).toBeTruthy();
    expect(postPath!.includes("_posts/2024-06-01-midyear-update.md")).toBe(true);
  });

  test("home page and post resolve to different files", () => {
    const homePath = idx.resolve("/");
    const postPath = idx.resolve("/blog/2024/01/15/first-post/");
    expect(homePath).toBeTruthy();
    expect(postPath).toBeTruthy();
    expect(homePath).not.toBe(postPath);
  });

  test("two posts resolve to different files", () => {
    const janPath = idx.resolve("/blog/2024/01/15/first-post/");
    const junPath = idx.resolve("/blog/2024/06/01/midyear-update/");
    expect(janPath).toBeTruthy();
    expect(junPath).toBeTruthy();
    expect(janPath).not.toBe(junPath);
  });
});

// ---------------------------------------------------------------------------
// Tests: Jekyll save operations with correct URL targeting
// ---------------------------------------------------------------------------

describe("Jekyll preset — save operations", () => {
  beforeEach(() => {
    resetFixture();
  });

  test("edit home page modifies only _index.md", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/",
      text: "# Welcome to My Jekyll Blog",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);
    expect(readFile("_index.md")).toContain("Welcome to My Jekyll Blog");
    // Posts should be unchanged
    expect(readFile("_posts/2024-01-15-first-post.md")).toContain("My First Post");
  });

  test("edit post through /blog/YYYY/MM/DD/slug/ URL targets _posts file", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/blog/2024/01/15/first-post/",
      text: "# Updated First Post Title",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Post file should be modified
    const postContent = readFile("_posts/2024-01-15-first-post.md");
    expect(postContent).toContain("Updated First Post Title");

    // Home page should be unchanged
    expect(readFile("_index.md")).toContain("Welcome to My Blog");

    // Other posts should be unchanged
    expect(readFile("_posts/2024-06-01-midyear-update.md")).toContain("Midyear Update");
  });

  test("edit about page targets about.md", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/about/",
      text: "# About This Blog",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);
    expect(readFile("about.md")).toContain("About This Blog");
  });

  test("delete on post modifies only that post file", async () => {
    const body = new URLSearchParams({
      action: "delete",
      blockId: "h2-0",
      path: "/blog/2024/06/01/midyear-update/",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);

    // June post should have h2 removed
    const junContent = readFile("_posts/2024-06-01-midyear-update.md");
    expect(junContent).not.toContain("## Goals Completed");

    // Home page should be unchanged
    expect(readFile("_index.md")).toContain("Welcome to My Blog");

    // January post should be unchanged
    expect(readFile("_posts/2024-01-15-first-post.md")).toContain("Hello world!");
  });

  test("move on post targets correct _posts file", async () => {
    const body = new URLSearchParams({
      action: "move",
      blockId: "h2-0",
      path: "/blog/2024/01/15/first-post/",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);

    // Verify home page not affected
    const homeContent = readFile("_index.md");
    expect(homeContent).toContain("Welcome to My Blog");
  });

  test("insert on post targets correct _posts file", async () => {
    const body = new URLSearchParams({
      action: "insert",
      afterBlockId: "h1-0",
      path: "/blog/2024/06/01/midyear-update/",
      tag: "p",
      text: "Extra paragraph added to midyear.",
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(200);
    expect(readFile("_posts/2024-06-01-midyear-update.md")).toContain("Extra paragraph added to midyear.");
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
      jekyllConfig,
      idx
    );

    expect(response.status).toBe(404);
  });

  test("YAML frontmatter preserved after Jekyll save", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/blog/2024/01/15/first-post/",
      text: "# Completely Rewritten Post Title",
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
      jekyllConfig,
      idx
    );

    const content = readFile("_posts/2024-01-15-first-post.md");
    expect(content).toContain("---");
    expect(content).toContain('title: "First Post"');
    expect(content).toContain("date: 2024-01-15");
    expect(content).toContain("category: tech");
    // Frontmatter with tags array preserved
    expect(content).toContain("tags:");
  });

  test("YAML frontmatter on regular page preserved", async () => {
    const body = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/about/",
      text: "# Who I Am",
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
      jekyllConfig,
      idx
    );

    const content = readFile("about.md");
    expect(content).toContain("---");
    expect(content).toContain('title: "About Me"');
    expect(content).toContain("layout: page");
  });

  test("multiple saves to different posts are isolated", async () => {
    // Save to January post
    const janBody = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/blog/2024/01/15/first-post/",
      text: "# January Edit",
    });

    await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: janBody.toString(),
      }),
      jekyllConfig,
      idx
    );

    // Save to June post
    const junBody = new URLSearchParams({
      action: "edit",
      blockId: "h1-0",
      path: "/blog/2024/06/01/midyear-update/",
      text: "# June Edit",
    });

    await handleSave(
      new Request("http://localhost/save", {
        method: "POST",
        headers: {
          "HX-Request": "true",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: junBody.toString(),
      }),
      jekyllConfig,
      idx
    );

    // Each post has only its own edit
    expect(readFile("_posts/2024-01-15-first-post.md")).toContain("January Edit");
    expect(readFile("_posts/2024-06-01-midyear-update.md")).toContain("June Edit");

    // Neither should have the other's edit
    expect(readFile("_posts/2024-01-15-first-post.md")).not.toContain("June Edit");
    expect(readFile("_posts/2024-06-01-midyear-update.md")).not.toContain("January Edit");
  });

  test("post date frontmatter survives save (critical Jekyll property)", async () => {
    const body = new URLSearchParams({
      action: "delete",
      blockId: "h2-0",
      path: "/blog/2024/06/01/midyear-update/",
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
      jekyllConfig,
      idx
    );

    const content = readFile("_posts/2024-06-01-midyear-update.md");
    // Date is critical for Jekyll URL routing — must not be lost
    expect(content).toContain("date: 2024-06-01");
  });
});
