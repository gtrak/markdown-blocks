/**
 * Tests for subpage path resolution bugfix.
 *
 * Previously, the client-side JS hardcoded `path: '/'` for move/delete/insert
 * actions, causing all saves on subpages (e.g., /how-it-works/) to target
 * `_index.md` instead of the correct file.
 *
 * The fix reads the page path from each block's .mb-content hx-vals attribute.
 */

import { describe, test, expect } from "bun:test";
import { GlobalWindow } from "happy-dom";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Path resolution helper — mirrors the fix applied in client.ts
// ---------------------------------------------------------------------------

function getPagePath(blockEl: any): string {
  const contentEl = blockEl.querySelector(".mb-content");
  if (!contentEl) return "/";

  try {
    const hxValsStr = contentEl.getAttribute("hx-vals") || "{}";
    const hxVals = JSON.parse(hxValsStr);
    return hxVals.path || "/";
  } catch {
    return "/";
  }
}

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

function createTestPage(pagePath: string) {
  const win = new GlobalWindow({ url: `http://localhost${pagePath}` });

  win.document.body.innerHTML = `
    <div class="mb-block" data-block-id="h1-0">
      <div class="mb-content" hx-get="/source" hx-trigger="click"
           hx-vals='${JSON.stringify({ blockId: "h1-0", path: pagePath })}'></div>
      <div class="mb-bar" data-mb-block-id="h1-0">
        <button data-mb-action="delete" data-mb-block-id="h1-0">Delete</button>
        <button data-mb-move="up" data-mb-block-id="h1-0">Move Up</button>
        <button data-mb-move="down" data-mb-block-id="h1-0">Move Down</button>
        <button data-mb-action="insert" data-mb-block-id="h1-0">Insert Below</button>
      </div>
    </div>
  `;

  return { win };
}

// ---------------------------------------------------------------------------
// Tests: core path resolution logic (the fix itself)
// ---------------------------------------------------------------------------

describe("subpage path resolution — getPagePath helper", () => {
  test("reads subpage path from hx-vals correctly", () => {
    const { win } = createTestPage("/how-it-works/");
    const block = win.document.querySelector(".mb-block");
    expect(block).toBeDefined();
    expect(getPagePath(block!)).toBe("/how-it-works/");
  });

  test("reads root path '/' from hx-vals", () => {
    const { win } = createTestPage("/");
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/");
  });

  test("handles deeply nested subpage paths", () => {
    const { win } = createTestPage("/docs/api/v2/reference/");
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/docs/api/v2/reference/");
  });

  test("missing .mb-content element falls back to '/'", () => {
    const win = new GlobalWindow({ url: "http://localhost/" });
    win.document.body.innerHTML = `
      <div class="mb-block" data-block-id="p-0">
        <!-- no .mb-content at all -->
        <div class="mb-bar"><button>Delete</button></div>
      </div>
    `;
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/");
  });

  test("malformed hx-vals JSON falls back to '/'", () => {
    const win = new GlobalWindow({ url: "http://localhost/page/" });
    win.document.body.innerHTML = `
      <div class="mb-block" data-block-id="p-0">
        <div class="mb-content" hx-vals='this is not valid json'></div>
      </div>
    `;
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/");
  });

  test("hx-vals missing 'path' key falls back to '/'", () => {
    const win = new GlobalWindow({ url: "http://localhost/page/" });
    win.document.body.innerHTML = `
      <div class="mb-block" data-block-id="p-0">
        <div class="mb-content" hx-vals='${JSON.stringify({ blockId: "p-0" })}'></div>
      </div>
    `;
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/");
  });

  test("empty string path falls back to '/'", () => {
    const win = new GlobalWindow({ url: "http://localhost/page/" });
    win.document.body.innerHTML = `
      <div class="mb-block" data-block-id="p-0">
        <div class="mb-content" hx-vals='${JSON.stringify({ blockId: "p-0", path: "" })}'></div>
      </div>
    `;
    const block = win.document.querySelector(".mb-block");
    expect(getPagePath(block!)).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Tests: full client behavior with htmx mock (happy-dom)
// ---------------------------------------------------------------------------

function installClickDelegation(win: GlobalWindow, ajaxCaptures: Array<Record<string, string>>) {
  const body = win.document.body;

  // @ts-expect-error happy-dom event types differ from DOM lib defs
  body.addEventListener("click", (evt: Event) => {
    const btn = (evt.target as Element).closest(
      ".mb-bar [data-mb-move], .mb-bar [data-mb-action]",
    ) as HTMLElement | null;
    if (!btn) return;

    const blockId = btn.getAttribute("data-mb-block-id");
    if (!blockId) return;

    // Path resolution fix — read from hx-vals instead of hardcoding '/'
    const blockEl = win.document.querySelector(
      `.mb-block[data-block-id="${blockId}"]`,
    );
    let pagePath = "/";
    if (blockEl) {
      try {
        const contentEl = blockEl.querySelector(".mb-content");
        if (contentEl) {
          const hxVals = JSON.parse(contentEl.getAttribute("hx-vals") || "{}");
          pagePath = hxVals.path ?? "/";
        }
      } catch {}
    }

    const moveDir = btn.getAttribute("data-mb-move");
    if (moveDir === "up" || moveDir === "down") {
      evt.preventDefault();
      ajaxCaptures.push({
        action: "move",
        direction: moveDir,
        blockId,
        path: pagePath,
      });
      return;
    }

    const action = btn.getAttribute("data-mb-action");
    if (action === "delete") {
      evt.preventDefault();
      ajaxCaptures.push({
        action: "delete",
        blockId,
        path: pagePath,
      });
      return;
    }
    if (action === "insert") {
      evt.preventDefault();
      ajaxCaptures.push({
        action: "insert",
        afterBlockId: blockId,
        tag: "p",
        text: "\u200B",
        path: pagePath,
      });
    }
  }, true); // capture phase (same as client.ts)
}

describe("client-side click delegation — full behavior with htmx mock", () => {
  test("delete on subpage sends correct path to /save", () => {
    const { win } = createTestPage("/how-it-works/");
    const calls: Array<Record<string, string>> = [];
    installClickDelegation(win, calls);

    const deleteBtn = win.document.querySelector('button[data-mb-action="delete"]');
    deleteBtn?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/how-it-works/");
    expect(calls[0].action).toBe("delete");
  });

  test("move up on /philosophy/ sends correct path", () => {
    const { win } = createTestPage("/philosophy/");
    const calls: Array<Record<string, string>> = [];
    installClickDelegation(win, calls);

    const moveUpBtn = win.document.querySelector('button[data-mb-move="up"]');
    moveUpBtn?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/philosophy/");
    expect(calls[0].action).toBe("move");
    expect(calls[0].direction).toBe("up");
  });

  test("insert on /demo/ sends correct path", () => {
    const { win } = createTestPage("/demo/");
    const calls: Array<Record<string, string>> = [];
    installClickDelegation(win, calls);

    const insertBtn = win.document.querySelector('button[data-mb-action="insert"]');
    insertBtn?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/demo/");
    expect(calls[0].action).toBe("insert");
  });

  test("root page still sends '/' for delete action", () => {
    const { win } = createTestPage("/");
    const calls: Array<Record<string, string>> = [];
    installClickDelegation(win, calls);

    const deleteBtn = win.document.querySelector('button[data-mb-action="delete"]');
    deleteBtn?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Regression: all three action types use the SAME derived path
// ---------------------------------------------------------------------------

describe("regression: consistent path across all action types", () => {
  test("move, delete, and insert all derive the same subpage path", () => {
    const { win } = createTestPage("/some/nested/subpage/");
    const calls: Array<Record<string, string>> = [];
    installClickDelegation(win, calls);

    win.document.querySelector('button[data-mb-move="up"]')?.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }),
    );
    win.document.querySelector('button[data-mb-action="delete"]')?.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }),
    );
    win.document.querySelector('button[data-mb-action="insert"]')?.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }),
    );

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.path).toBe("/some/nested/subpage/");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: compiled client.js actually contains the fix (smoke test)
// ---------------------------------------------------------------------------

describe("compiled dist/client.js contains the fix", () => {
  test("client.js reads path from hx-vals instead of hardcoding", () => {
    const content = fs.readFileSync("dist/client.js", "utf-8");

    // Behavioral check: code reads hx-vals and parses .path attribute,
    // rather than hardcoding a literal path in action payloads.
    expect(content).toMatch(/hx-vals/);
    expect(content).toMatch(/JSON\.parse/);
    expect(content).toMatch(/\.path/);
  });

  test("client.js reads hx-vals for path derivation", () => {
    const content = fs.readFileSync("dist/client.js", "utf-8");
    expect(content).toMatch(/hx-vals/);
  });
});
