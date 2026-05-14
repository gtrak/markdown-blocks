/**
 * Unit tests for SSG preset URL resolution.
 *
 * Tests each preset's resolveUrl behavior with various file paths,
 * frontmatter overrides, and edge cases.
 */

import { test, expect, describe } from "bun:test";
import { createSaveHandler } from "../src/server.js";
import { getPreset, normalizeTrailingSlash, listPresets, AVAILABLE_PRESETS } from "../src/config.js";
import { Preset } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolve(preset: string, relativePath: string, fm: Record<string, unknown> = {}): string | null {
  const p = getPreset(preset);
  return p.resolveUrl(relativePath, fm);
}

// ---------------------------------------------------------------------------
// Available presets metadata
// ---------------------------------------------------------------------------

describe("preset registry", () => {
  test("AVAILABLE_PRESETS lists all expected presets", () => {
    expect(AVAILABLE_PRESETS).toContain("zola");
    expect(AVAILABLE_PRESETS).toContain("hugo");
    expect(AVAILABLE_PRESETS).toContain("jekyll");
    expect(AVAILABLE_PRESETS).toContain("generic");
  });

  test("listPresets returns metadata for each preset", () => {
    const presets = listPresets();
    expect(presets.length).toBe(4);

    // Each should have a name and commentPassthroughHint
    for (const p of presets) {
      expect(p.name).toBeTruthy();
      expect(typeof p.commentPassthroughHint).toBe("string");
    }
  });

  test("listPresets includes defaultContentDir", () => {
    const presets = listPresets();
    const zola = presets.find((p) => p.name === "zola")!;
    expect(zola.defaultContentDir).toBe("content");

    const hugo = presets.find((p) => p.name === "hugo")!;
    expect(hugo.defaultContentDir).toBe("content");

    const jekyll = presets.find((p) => p.name === "jekyll")!;
    expect(jekyll.defaultContentDir).toBe("_posts");
  });

  test("listPresets includes frontmatter format", () => {
    const presets = listPresets();
    const zola = presets.find((p) => p.name === "zola")!;
    expect(zola.defaultFrontmatterFormat).toBe("toml");

    const hugo = presets.find((p) => p.name === "hugo")!;
    expect(hugo.defaultFrontmatterFormat).toBe("yaml");

    const jekyll = presets.find((p) => p.name === "jekyll")!;
    expect(jekyll.defaultFrontmatterFormat).toBe("yaml");
  });

  test("unknown preset throws descriptive error", () => {
    expect(() => getPreset("eleventy")).toThrow(/Unknown preset.*eleventy/);
    expect(() => getPreset("eleventy")).toThrow(/zola.*hugo.*jekyll.*generic/);
  });
});

// ---------------------------------------------------------------------------
// Zola preset tests
// ---------------------------------------------------------------------------

describe("Zola preset URL resolution", () => {
  test("root _index.md resolves to /", () => {
    expect(resolve("zola", "_index.md")).toBe("/");
  });

  test("nested _index.md resolves to section path", () => {
    expect(resolve("zola", "blog/_index.md")).toBe("/blog/");
    expect(resolve("zola", "docs/api/v2/_index.md")).toBe("/docs/api/v2/");
  });

  test("regular file at root", () => {
    expect(resolve("zola", "about.md")).toBe("/about/");
  });

  test("regular file in subsection", () => {
    expect(resolve("zola", "posts/hello-world.md")).toBe("/posts/hello-world/");
  });

  test("page bundle index.md uses parent dir as URL", () => {
    expect(resolve("zola", "articles/my-post/index.md")).toBe("/articles/my-post/");
  });

  test("frontmatter path override", () => {
    expect(resolve("zola", "posts/hello.md", { path: "/custom-url/" })).toBe("/custom-url/");
    // Without leading slash — normalized by Zola preset itself
    expect(resolve("zola", "posts/hello.md", { path: "custom-relative/" })).toBe("/custom-relative/");
  });

  test("frontmatter slug override", () => {
    expect(resolve("zola", "posts/my-post-name.md", { slug: "renamed" })).toBe("/posts/renamed/");
  });

  test("path takes priority over slug", () => {
    const result = resolve("zola", "posts/file.md", { path: "/explicit/", slug: "ignored" });
    expect(result).toBe("/explicit/");
  });

  test("strips .markdown extension", () => {
    expect(resolve("zola", "about.markdown")).toBe("/about/");
  });
});

// ---------------------------------------------------------------------------
// Hugo preset tests
// ---------------------------------------------------------------------------

describe("Hugo preset URL resolution", () => {
  test("root _index.md resolves to /", () => {
    expect(resolve("hugo", "_index.md")).toBe("/");
  });

  test("nested _index.md resolves to section path", () => {
    expect(resolve("hugo", "blog/_index.md")).toBe("/blog/");
    expect(resolve("hugo", "docs/tutorials/_index.md")).toBe("/docs/tutorials/");
  });

  test("regular file at root", () => {
    expect(resolve("hugo", "about.md")).toBe("/about/");
  });

  test("regular file in subsection", () => {
    expect(resolve("hugo", "posts/hello-world.md")).toBe("/posts/hello-world/");
  });

  test("page bundle index.md uses parent dir as URL", () => {
    expect(resolve("hugo", "articles/my-post/index.md")).toBe("/articles/my-post/");
  });

  test("frontmatter url override (Hugo native)", () => {
    expect(resolve("hugo", "posts/hello.md", { url: "/custom-url/" })).toBe("/custom-url/");
    expect(resolve("hugo", "posts/hello.md", { url: "no-leading-slash" })).toBe("/no-leading-slash/");
  });

  test("frontmatter path override (cross-compat with Zola)", () => {
    expect(resolve("hugo", "posts/hello.md", { path: "/alt-path/" })).toBe("/alt-path/");
  });

  test("url takes priority over path override", () => {
    const result = resolve("hugo", "posts/file.md", { url: "/hugo-win/", path: "/zola-lose/" });
    expect(result).toBe("/hugo-win/");
  });

  test("frontmatter slug override", () => {
    expect(resolve("hugo", "posts/my-post-name.md", { slug: "renamed" })).toBe("/posts/renamed/");
  });

  test("strips .markdown extension", () => {
    expect(resolve("hugo", "about.markdown")).toBe("/about/");
  });
});

// ---------------------------------------------------------------------------
// Jekyll preset tests
// ---------------------------------------------------------------------------

describe("Jekyll preset URL resolution", () => {
  test("post date format resolves to /blog/YYYY/MM/DD/title/", () => {
    expect(resolve("jekyll", "_posts/2024-01-15-hello-world.md")).toBe("/blog/2024/01/15/hello-world/");
  });

  test("post without _posts prefix still matches date pattern", () => {
    expect(resolve("jekyll", "2024-06-01-midyear.md")).toBe("/blog/2024/06/01/midyear/");
  });

  test("regular page resolves by filename", () => {
    expect(resolve("jekyll", "about.md")).toBe("/about/");
    expect(resolve("jekyll", "contact/index.md")).toBe("/contact/index/");
  });

  test("frontmatter permalink override (Jekyll native)", () => {
    expect(resolve("jekyll", "_posts/2024-01-01-old.md", { permalink: "/news/new-year/" })).toBe(
      "/news/new-year/",
    );
  });

  test("frontmatter url override also works", () => {
    expect(resolve("jekyll", "some-page.md", { url: "/custom/" })).toBe("/custom/");
  });

  test("permalink takes priority over url", () => {
    const result = resolve("jekyll", "page.md", { permalink: "/first/", url: "/second/" });
    expect(result).toBe("/first/");
  });
});

// ---------------------------------------------------------------------------
// Generic preset tests
// ---------------------------------------------------------------------------

describe("Generic preset URL resolution", () => {
  test("simple file at root", () => {
    expect(resolve("generic", "about.md")).toBe("/about/");
  });

  test("nested file", () => {
    expect(resolve("generic", "posts/hello.md")).toBe("/posts/hello/");
  });

  test("_index.md is NOT special-cased (unlike Zola/Hugo)", () => {
    expect(resolve("generic", "_index.md")).toBe("/_index/");
    expect(resolve("generic", "section/_index.md")).toBe("/section/_index/");
  });

  test("strips .markdown extension", () => {
    expect(resolve("generic", "page.markdown")).toBe("/page/");
  });
});

// ---------------------------------------------------------------------------
// Trailing slash normalization
// ---------------------------------------------------------------------------

describe("normalizeTrailingSlash", () => {
  test("adds trailing slash when requested", () => {
    expect(normalizeTrailingSlash("/page", true)).toBe("/page/");
    expect(normalizeTrailingSlash("/posts/hello", true)).toBe("/posts/hello/");
  });

  test("removes trailing slash when requested", () => {
    expect(normalizeTrailingSlash("/page/", false)).toBe("/page");
    expect(normalizeTrailingSlash("/posts/hello/", false)).toBe("/posts/hello");
  });

  test("root / is always preserved", () => {
    expect(normalizeTrailingSlash("/", true)).toBe("/");
    expect(normalizeTrailingSlash("/", false)).toBe("/");
  });

  test("no-op when already correct", () => {
    expect(normalizeTrailingSlash("/page/", true)).toBe("/page/");
    expect(normalizeTrailingSlash("/page", false)).toBe("/page");
  });
});
