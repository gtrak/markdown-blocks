import fs from "node:fs";
import path from "node:path";
import { Config } from "./types.js";
import { walkMarkdownFiles } from "./annotate.js";
import { getPreset, parseFrontmatterFromContent, normalizeTrailingSlash } from "./config.js";

/** Build or rebuild the URL→filepath index for all .md files under contentDir (internal). */
function buildIndexInternal(config: Config): Map<string, string> {
  // Verify contentDir exists
  if (!fs.existsSync(config.contentDir)) {
    throw new Error(`Content directory does not exist: ${config.contentDir}`);
  }

  const map = new Map<string, string>();

  const files = walkMarkdownFiles(config.contentDir);

  for (const filepath of files) {
    // Read file and extract frontmatter
    const content = fs.readFileSync(filepath, "utf-8");
    const fm = parseFrontmatterFromContent(content);

    // Compute relative path from contentDir
    const relativePath = path.relative(config.contentDir, filepath);

    // Resolve URL using preset
    const preset = getPreset(config.preset);
    const url = preset.resolveUrl(relativePath, fm);

    if (url !== null) {
      // Normalize trailing slash per config setting
      const normalized = normalizeTrailingSlash(url, config.trailingSlash ?? true);
      const absolutePath = path.resolve(filepath);

      // Handle URL collisions: last file wins
      if (map.has(normalized)) {
        console.warn(
          `[indexer] URL collision for "${normalized}": "${map.get(normalized)}" overridden by "${absolutePath}"`,
        );
      }
      map.set(normalized, absolutePath);
    }
  }

  return map;
}



/** Lazy URL-to-source indexer. Maps resolved URLs to source file paths. */
export class Indexer {
  private config: Config;
  private index = new Map<string, string>();
  private watchHandle: ReturnType<typeof setInterval> | null = null;
  private fsWatchers: fs.FSWatcher[] = [];
  private onChangeCallback: (() => void) | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  /** Build or rebuild the URL→filepath map. */
  build(): void {
    this.index = buildIndexInternal(this.config);
  }

  /** Look up a source filepath for a given URL path. Manual overrides take priority. */
  resolve(urlPath: string): string | null {
    // Manual overrides in config.pathMap take priority over index
    if (this.config.pathMap && urlPath in this.config.pathMap) {
      const mapped = this.config.pathMap[urlPath];
      // If the mapped path is absolute, use it as-is; otherwise resolve relative to contentDir
      return path.isAbsolute(mapped) ? mapped : path.resolve(this.config.contentDir, mapped);
    }
    return this.index.get(urlPath) ?? null;
  }

  /** Get raw map (for debugging/testing). */
  getMap(): Map<string, string> {
    return this.index;
  }

  /** Set up file watcher that rebuilds the index on .md file changes. */
  watch(onChange: () => void): void {
    this.onChangeCallback = onChange;

    const rebuildWithNotify = () => {
      this.build();
      if (this.onChangeCallback) this.onChangeCallback();
    };

    // Debounced rebuild for rapid changes (e.g., editors writing to files).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(rebuildWithNotify, 100);
    };

    // Walk contentDir and set up recursive file watchers.
    this.watchFs(this.config.contentDir, "*.md", debounced);
  }

  /** Stop watching. */
  stopWatch(): void {
    if (this.watchHandle) {
      clearInterval(this.watchHandle);
      this.watchHandle = null;
    }
    for (const watcher of this.fsWatchers) {
      watcher.close();
    }
    this.fsWatchers = [];
    this.onChangeCallback = null;
  }

  /** Recursively set up fs.watch on directories, watching for .md changes. */
  private watchFs(dir: string, _glob: string, onChange: () => void): void {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;

    try {
      // Use recursive watch (supported in Bun / Node 20+).
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && path.extname(filename) === ".md") {
          onChange();
        }
      });
      this.fsWatchers.push(watcher);
    } catch {
      // Fallback: set up periodic polling if fs.watch with recursive fails.
      if (!this.watchHandle) {
        this.watchHandle = setInterval(onChange, 1000);
      }
    }

    // recursive: true already covers all subdirectories; no manual recursion needed.
  }
}

/** Standalone function to build an index from config (convenient for tests). */
export function buildIndex(config: Config): Map<string, string> {
  const indexer = new Indexer(config);
  indexer.build();
  return indexer.getMap();
}
