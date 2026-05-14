/**
 * Unit tests for all preset URL resolution logic.
 *
 * Each preset gets its own describe block testing:
 * - Basic file→URL mapping
 * - _index.md / section page resolution
 * - Frontmatter override fields (url, path, permalink, slug)
 * - Trailing slash normalization
 * - Edge cases and error handling
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { getPreset, normalizeTrailingSlash, listPresets, AVAILABLE_PRESETS } from "../src/config.js";
import { Preset } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Get a fresh preset with given trailingSlash setting. */
function getFreshPreset(name: string, trailingSlash = true): Preset {
  // getPreset caches per-name with trailingSlash=true as default,
  // so for trailingSlash=false tests we create inline.
  // For now just use the cached version (trailingSlash=true).
  return getPreset(name);
}

// ---------------------------------------------------------------------------
// Available presets metadata
// ---------------------------------------------------------------------------

describe("preset registry", () => {
  test("AVAILABLE_PRESETS includes all four presets", () => {
    expect(AVAILABLE_PRESETS).toContain("zola");
    expect(AVAILABLE_PRESETS).toContain("hugo");
    expect(AVAILABLE_PRESETS).toContain("jekyll");
    expect(AVAILABLE_PRESETS).toContain("generic");
  });

  test("listPresets returns all presets with metadata", () => {
    const presets = listPresets();
    expect(presets.length).toBe(4);
    
    // Each preset should have metadata
    for (const p of presets) {
      expect(p).toHaveProperty("name");
    }
  });

  test("hugo preset has correct defaults", () => {
    const presets = listPresets();
    const hugo = presets.find(p => p.name === "hugo");
    expect(hugo).toBeTruthy();
    expect(hugo!.defaultContentDir).toBe("content");
    expect(hugo!.defaultFrontmatterFormat).toBe("yaml");
    expect(hugo!.commentPassthroughHint).toContain("Hugo");
  });

  test("zola preset has correct defaults", () => {
    const presets = listPresets();
    const zola = presets.find(p => p.name === "zola");
    expect(zola).toBeTruthy();
    expect(zola!.defaultContentDir).toBe("content");
    expect(zola!.defaultFrontmatterFormat).toBe("toml");
  });

  test("jekyll preset has correct defaults", () => {
    const presets = listPresets();
    const jekyll = presets.find(p => p.name === "jekyll");
    expect(jekyll).toBeTruthy();
    expect(jekyll!.defaultContentDir).toBe("_posts");
    expect(jekyll!.defaultFrontmatterFormat).toBe("yaml");
  });

  test("unknown preset throws error", () => {
    expect(() => getPreset("nonexistent")).toThrow("Unknown preset");
  });
});

// ---------------------------------------------------------------------------
// normalizeTrailingSlash helper
// ---------------------------------------------------------------------------

describe("normalizeTrailingSlash", () => {
  test("root / is always unchanged", () => {
    expect(normalizeTrailingSlash("/", true)).toBe("/");
    expect(normalizeTrailingSlash("/", false)).toBe("/");
  });

  test("wantSlash adds trailing slash when missing", () => {
    expect(normalizeTrailingSlash("/page", true)).toBe("/page/");
  });

  test("noSlash removes trailing slash when present", () => {
    expect(normalizeTrailingSlash("/page/", false)).toBe("/page");
  });

  test("already correct returns unchanged", () => {
    expect(normalizeTrailingSlash("/page/", true)).toBe("/page/");
    expect(normalizeTrailingSlash("/page", false)).toBe("/page");
  });
});

// ---------------------------------------------------------------------------
// Hugo preset URL resolution
// ---------------------------------------------------------------------------

describe("Hugo preset — resolveUrl", () => {
  const resolve = getFreshPreset("hugo").resolveUrl;

  test("_index.md at root resolves to /", () => {
    expect(resolve("_index.md", {})).toBe("/");
  });

  test("_index.md in subdir resolves to section page", () => {
    expect(resolve("blog/_index.md", {})).toBe("/blog/");
  });

  test("regular file in section gets section URL", () => {
    expect(resolve("posts/hello.md", {})).toBe("/posts/hello/");
  });

  test("deeply nested file resolves correctly", () => {
    expect(resolve("docs/api/v2/endpoints.md", {})).toBe("/docs/api/v2/endpoints/");
  });

  test("frontmatter url overrides everything (Hugo native)", () => {
    expect(resolve("posts/hello.md", { url: "/custom-path/" })).toBe("/custom-path/");
  });

  test("frontmatter path also accepted for cross-compat", () => {
    expect(resolve("posts/hello.md", { path: "/alt-path/" })).toBe("/alt-path/");
  });

  test("url frontmatter takes priority over path", () => {
    expect(resolve("posts/hello.md", { url: "/url-wins/", path: "/path-loses/" })).toBe("/url-wins/");
  });

  test("slug overrides filename segment", () => {
    expect(resolve("posts/my-post.md", { slug: "renamed" })).toBe("/posts/renamed/");
  });

  test("returns null for empty relativePath", () => {
    expect(resolve("", {})).toBeNull();
    expect(resolve(null as any, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zola preset URL resolution
// ---------------------------------------------------------------------------

describe("Zola preset — resolveUrl", () => {
  const resolve = getFreshPreset("zola").resolveUrl;

  test("_index.md at root resolves to /", () => {
    expect(resolve("_index.md", {})).toBe("/");
  });

  test("_index.md in subdir resolves to section page", () => {
    expect(resolve("blog/_index.md", {})).toBe("/blog/");
  });

  test("frontmatter path overrides URL (Zola native)", () => {
    expect(resolve("posts/hello.md", { path: "/custom/" })).toBe("/custom/");
  });

  test("slug overrides filename segment", () => {
    expect(resolve("posts/my-post.md", { slug: "renamed" })).toBe("/posts/renamed/");
  });
});

// ---------------------------------------------------------------------------
// Jekyll preset URL resolution
// ---------------------------------------------------------------------------

describe("Jekyll preset — resolveUrl", () => {
  const resolve = getFreshPreset("jekyll").resolveUrl;

  test("_posts date-based filename maps to /blog/YYYY/MM/DD/slug/", () => {
    expect(resolve("_posts/2024-01-15-hello-world.md", {})).toBe(
      "/blog/2024/01/15/hello-world/"
    );
  });

  test("date-based filename without _posts prefix still works", () => {
    expect(resolve("2023-06-01-post-title.md", {})).toBe(
      "/blog/2023/06/01/post-title/"
    );
  });

  test("frontmatter permalink overrides everything (Jekyll native)", () => {
    expect(resolve("_posts/2024-01-01-hello.md", { permalink: "/articles/hello/" })).toBe(
      "/articles/hello/"
    );
  });

  test("frontmatter url also accepted", () => {
    expect(resolve("about.md", { url: "/custom-about/" })).toBe("/custom-about/");
  });

  test("permalink takes priority over url", () => {
    expect(resolve("page.md", { permalink: "/perm-wins/", url: "/url-loses/" })).toBe(
      "/perm-wins/"
    );
  });

  test("regular page (non-post) resolves by filename", () => {
    expect(resolve("about.md", {})).toBe("/about/");
  });
});

// ---------------------------------------------------------------------------
// Generic preset URL resolution
// ---------------------------------------------------------------------------

describe("Generic preset — resolveUrl", () => {
  const resolve = getFreshPreset("generic").resolveUrl;

  test("strips .md extension and adds trailing slash", () => {
    expect(resolve("page.md", {})).toBe("/page/");
  });

  test("nested paths preserved", () => {
    expect(resolve("a/b/c/file.md", {})).toBe("/a/b/c/file/");
  });

  test("no special handling for _index.md", () => {
    // Generic preset treats _index as a regular file
    expect(resolve("_index.md", {})).toBe("/_index/");
  });
});
