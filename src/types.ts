/** Block represents a parsed markdown block with source position info */
export interface Block {
  tag: string;           // "h1", "h2", "p", "code", "blockquote", etc.
  index: number;         // per-tag sequential index (first h1 = 0, second h1 = 1)
  itemIndex?: number;    // optional: index within parent list (for li items)
  position: {
    start: { line: number; column: number };
    end:   { line: number; column: number };
  };
}

/** BlockId is parsed from "tag-index" format, e.g. "h1-3", "p-0", "ul-0-i1" */
export interface BlockId {
  tag: string;
  index: number;
  itemIndex?: number;    // optional: index within parent list
}

/** Parse a block id string ("tag-index" or "tag-index-iN") into a BlockId object. */
export function parseBlockId(id: string): BlockId | null {
  // Check for item index suffix: "-iN"
  const itemMatch = id.match(/^(.+-)(\d+)-i(\d+)$/);
  if (itemMatch) {
    const baseId = itemMatch[1] + itemMatch[2];
    const dashIdx = baseId.lastIndexOf('-');
    if (dashIdx <= 0) return null;
    const tag = baseId.slice(0, dashIdx);
    const indexStr = baseId.slice(dashIdx + 1);
    if (!/^\d+$/.test(indexStr)) return null;
    return { tag, index: Number(indexStr), itemIndex: Number(itemMatch[3]) };
  }

  // Standard "tag-index"
  const dashIdx = id.lastIndexOf('-');
  if (dashIdx <= 0) return null;
  const tag = id.slice(0, dashIdx);
  const indexStr = id.slice(dashIdx + 1);
  if (!/^\d+$/.test(indexStr)) return null;
  const index = Number(indexStr);
  return { tag, index };
}

/** Format a BlockId object into "tag-index" or "tag-index-iN" string. */
export function formatBlockId(blockId: BlockId): string {
  if (blockId.itemIndex !== undefined) {
    return `${blockId.tag}-${blockId.index}-i${blockId.itemIndex}`;
  }
  return `${blockId.tag}-${blockId.index}`;
}

// --- Config ---

/** Config for the save server */
export interface Config {
  contentDir: string;              // path to markdown source files
  preset: string;                  // SSG preset name ("zola" or "generic")
  trailingSlash?: boolean;         // normalize trailing slashes
  backendProxyUrl?: string;        // optional proxy target
  pathMap?: Record<string, string>;// manual URL→filepath overrides
  contentSelector?: string;        // HTML selector for editable area (default: "main")
  /** How HTMX is served: "cdn" (default) or "bundled" (served locally) */
  htmxSource?: "cdn" | "bundled";
}

// --- Preset ---

/** What frontmatter format does this SSG use by default? */
export type FrontmatterFormat = "yaml" | "toml";

/** Preset computes URL paths from source file layout and provides SSG conventions. */
export interface Preset {
  name: string;
  /** Default content directory for this SSG (e.g., "content" for Hugo/Zola). */
  defaultContentDir?: string;
  /** Default frontmatter format for this SSG. */
  defaultFrontmatterFormat?: FrontmatterFormat;
  /** Human-readable hint on how to configure the SSG to pass markdown comments through. */
  commentPassthroughHint?: string;

  /**
   * Resolve a URL path from a relative file path and its frontmatter.
   * @param relativePath - Path relative to contentDir, e.g. "posts/hello.md" or "_index.md"
   * @param frontmatter - Parsed frontmatter object
   * @returns The resolved URL path (e.g., "/posts/hello/") or null if file should be skipped
   */
  resolveUrl(relativePath: string, frontmatter: Record<string, unknown>): string | null;
}
