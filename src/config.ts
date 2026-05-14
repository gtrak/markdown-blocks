import path from "node:path";
import { Preset } from "./types.js";
import { extractFrontmatter as extractFmAst } from "./ast.js";

// --- Frontmatter parsing (delegated to AST pipeline) ---

/** Parse frontmatter from raw markdown content. Returns parsed object or empty record. */
export function parseFrontmatterFromContent(content: string): Record<string, unknown> {
  return extractFmAst(content).parsed;
}

// --- Preset registry ---

/**
 * Zola-style URL resolution:
 * - _index.md at root → "/"
 * - _index.md in subdir → "/<subdir>/" (section page)
 * - <name>.md at root → "/<name>/"
 * - <name>.md in subdir → "/<subdir>/<name>/"
 * - index.md in a directory (page bundle) → parent dir URL
 * - frontmatter `path` field overrides full path
 * - frontmatter `slug` field overrides the URL segment for that file
 */
function createZolaPreset(trailingSlash: boolean): Preset {
  return {
    name: "zola",
    defaultContentDir: "content",
    defaultFrontmatterFormat: "toml",
    commentPassthroughHint:
      "Zola passes HTML comments through by default — no special configuration needed.",
    resolveUrl(relativePath, fm) {
      if (!relativePath || typeof relativePath !== "string") return null;

      // frontmatter `path` overrides everything
      if (typeof fm.path === "string" && fm.path.length > 0) {
        let p = fm.path as string;
        // Normalize: ensure leading slash
        if (!p.startsWith("/")) p = "/" + p;
        if (trailingSlash && !p.endsWith("/")) p += "/";
        if (!trailingSlash && p.endsWith("/") && p !== "/") p = p.slice(0, -1);
        return p;
      }

      const ext = path.extname(relativePath);
      let bare: string;

      // Strip frontmatter extension (.md, .markdown, etc.)
      if ([".md", ".markdown"].includes(ext)) {
        bare = relativePath.slice(0, -ext.length);
      } else {
        bare = relativePath;
      }

      const segments = bare.split("/");
      const leaf = segments[segments.length - 1] || "";

      // _index.md → section page
      if (leaf === "_index") {
        let url: string;
        if (segments.length === 1) {
          url = "/";
        } else {
          segments.pop();
          url = "/" + segments.join("/") + "/";
        }
        return normalizeTrailingSlash(url, trailingSlash);
      }

      // index.md in a directory → page bundle (use parent dir as URL)
      if (leaf === "index" && segments.length > 1) {
        segments.pop();
        let url = "/" + segments.join("/") + "/";
        return normalizeTrailingSlash(url, trailingSlash);
      }

      // Regular file: <name>.md at root → /<name>/ or in subdir → /<subdir>/<name>/
      if (typeof fm.slug === "string" && fm.slug.length > 0) {
        segments[segments.length - 1] = fm.slug as string;
      }
      let url = "/" + segments.join("/") + "/";
      return normalizeTrailingSlash(url, trailingSlash);
    },
  };
}

/**
 * Generic preset: strip .md, add trailing slash. No _index.md special-casing.
 */
function createGenericPreset(trailingSlash: boolean): Preset {
  return {
    name: "generic",
    defaultContentDir: "content",
    defaultFrontmatterFormat: "yaml",
    commentPassthroughHint:
      "Ensure your static site generator passes HTML comments through during rendering. Most SSGs do this by default.",
    resolveUrl(relativePath, _fm) {
      if (!relativePath || typeof relativePath !== "string") return null;

      const ext = path.extname(relativePath);
      let bare: string;
      if ([".md", ".markdown"].includes(ext)) {
        bare = relativePath.slice(0, -ext.length);
      } else {
        bare = relativePath;
      }

      let url = "/" + bare + "/";
      return normalizeTrailingSlash(url, trailingSlash);
    },
  };
}

/**
 * Hugo-style URL resolution:
 * - _index.md at root → "/"
 * - _index.md in subdir → "/<subdir>/" (section page)
 * - <name>.md at root → "/<name>/" (rare — Hugo usually nests under sections)
 * - <name>.md in subdir → "/<subdir>/<name>/"
 * - frontmatter `url` field overrides full path
 * - frontmatter `slug` field overrides the URL segment for that file
 *
 * Comment passthrough: Hugo renders HTML comments by default — no special
 * configuration needed, but if using a markdown processor like Goldmark you
 * may need `unsafe: true` in hugo.toml render hooks.
 */
function createHugoPreset(trailingSlash: boolean): Preset {
  return {
    name: "hugo",
    defaultContentDir: "content",
    defaultFrontmatterFormat: "yaml",
    commentPassthroughHint:
      "Hugo renders HTML comments by default. If using Goldmark, ensure render hooks or unsafe mode are enabled for raw HTML passthrough.",
    resolveUrl(relativePath, fm) {
      if (!relativePath || typeof relativePath !== "string") return null;

      // frontmatter `url` overrides everything (Hugo's native override field)
      if (typeof fm.url === "string" && fm.url.length > 0) {
        let p = fm.url as string;
        if (!p.startsWith("/")) p = "/" + p;
        return normalizeTrailingSlash(p, trailingSlash);
      }

      // Also accept Zola-style `path` for cross-compat
      if (typeof fm.path === "string" && fm.path.length > 0) {
        let p = fm.path as string;
        if (!p.startsWith("/")) p = "/" + p;
        return normalizeTrailingSlash(p, trailingSlash);
      }

      const ext = path.extname(relativePath);
      let bare: string;

      // Strip markdown extension
      if ([".md", ".markdown"].includes(ext)) {
        bare = relativePath.slice(0, -ext.length);
      } else {
        bare = relativePath;
      }

      const segments = bare.split("/");
      const leaf = segments[segments.length - 1] || "";

      // _index.md → section page
      if (leaf === "_index") {
        let url: string;
        if (segments.length === 1) {
          url = "/";
        } else {
          segments.pop();
          url = "/" + segments.join("/") + "/";
        }
        return normalizeTrailingSlash(url, trailingSlash);
      }

      // index.md in a directory → page bundle (use parent dir as URL)
      if (leaf === "index" && segments.length > 1) {
        segments.pop();
        let url = "/" + segments.join("/") + "/";
        return normalizeTrailingSlash(url, trailingSlash);
      }

      // Regular file: use slug if set
      if (typeof fm.slug === "string" && fm.slug.length > 0) {
        segments[segments.length - 1] = fm.slug as string;
      }
      let url = "/" + segments.join("/") + "/";
      return normalizeTrailingSlash(url, trailingSlash);
    },
  };
}

/**
 * Jekyll-style URL resolution:
 * - Files in _posts/ use date-based URLs: _posts/2024-01-01-hello.md → /blog/2024/01/01/hello
 * - _config.yml frontmatter defaults apply
 * - Regular pages resolve by filename (minus extension)
 * - Collections (_drafts, custom) are excluded from URL mapping
 */
function createJekyllPreset(trailingSlash: boolean): Preset {
  return {
    name: "jekyll",
    defaultContentDir: "_posts",
    defaultFrontmatterFormat: "yaml",
    commentPassthroughHint:
      "Jekyll passes HTML comments through by default. If using kramdown, ensure `input: GFM` or comments are preserved.",
    resolveUrl(relativePath, fm) {
      if (!relativePath || typeof relativePath !== "string") return null;

      // frontmatter `permalink` overrides everything (Jekyll's native override field)
      if (typeof fm.permalink === "string" && fm.permalink.length > 0) {
        let p = fm.permalink as string;
        if (!p.startsWith("/")) p = "/" + p;
        return normalizeTrailingSlash(p, trailingSlash);
      }

      // frontmatter `url` also accepted
      if (typeof fm.url === "string" && fm.url.length > 0) {
        let p = fm.url as string;
        if (!p.startsWith("/")) p = "/" + p;
        return normalizeTrailingSlash(p, trailingSlash);
      }

      const ext = path.extname(relativePath);
      let bare: string;

      // Strip markdown extension
      if ([".md", ".markdown"].includes(ext)) {
        bare = relativePath.slice(0, -ext.length);
      } else {
        bare = relativePath;
      }

      const segments = bare.split("/");
      const leaf = segments[segments.length - 1] || "";

      // _index.md → section/home page (cross-compat with Zola/Hugo)
      if (leaf === "_index") {
        let url: string;
        if (segments.length === 1) {
          url = "/";
        } else {
          segments.pop();
          url = "/" + segments.join("/") + "/";
        }
        return normalizeTrailingSlash(url, trailingSlash);
      }

      // _posts/YYYY-MM-DD-title.md → /blog/YYYY/MM/DD/title/
      const postMatch = bare.match(/^(?:_posts\/)?(\d{4})-(\d{2})-(\d{2})-(.+)$/);
      if (postMatch) {
        const [, year, month, day, title] = postMatch;
        return normalizeTrailingSlash(`/blog/${year}/${month}/${day}/${title}/`, trailingSlash);
      }

      // Regular file
      return normalizeTrailingSlash("/" + bare + "/", trailingSlash);
    },
  };
}

export function normalizeTrailingSlash(url: string, wantSlash: boolean): string {
  if (url === "/") return url;
  if (wantSlash && !url.endsWith("/")) return url + "/";
  if (!wantSlash && url.endsWith("/")) return url.slice(0, -1);
  return url;
}

const PRESETS: Record<string, Preset> = {};

/** Available preset names. */
export const AVAILABLE_PRESETS = ["zola", "hugo", "jekyll", "generic"] as const;

/** Get a preset by name. Throws if unknown. Supports "zola", "hugo", "jekyll", and "generic". */
export function getPreset(name: string): Preset {
  // Lazily create with trailingSlash=true as default
  if (!PRESETS[name]) {
    switch (name) {
      case "zola":
        PRESETS[name] = createZolaPreset(true);
        break;
      case "hugo":
        PRESETS[name] = createHugoPreset(true);
        break;
      case "jekyll":
        PRESETS[name] = createJekyllPreset(true);
        break;
      case "generic":
        PRESETS[name] = createGenericPreset(true);
        break;
      default:
        throw new Error(
          `Unknown preset: ${name}. Available presets: zola, hugo, jekyll, generic`,
        );
    }
  }
  return PRESETS[name];
}

/** List all available preset names and metadata. */
export function listPresets(): Array<{ name: string; defaultContentDir?: string; defaultFrontmatterFormat?: string; commentPassthroughHint?: string }> {
  return AVAILABLE_PRESETS.map((name) => {
    const p = getPreset(name);
    return {
      name: p.name,
      defaultContentDir: p.defaultContentDir,
      defaultFrontmatterFormat: p.defaultFrontmatterFormat,
      commentPassthroughHint: p.commentPassthroughHint,
    };
  });
}
