---
title: "markdown-blocks"
description: "Block-level in-browser editing for static Markdown sites"
draft: false
---

# markdown-blocks

Bun runtime package that adds block-level in-browser editing to any static Markdown site. Server assigns stable block IDs from source file line numbers, client sends edits back by block ID.

## How it works

The save server sits between the browser and your static site generator (Zola, Hugo, Jekyll, etc.) as a reverse proxy. On every page request it:

1. **Proxies** the HTML from your SSG
2. **Wraps** each markdown block with HTMX shell markup using comment anchors injected during build
3. **Injects** HTMX (CDN), editing CSS, and the client module — all automatically

The client module activates event delegation: clicking a block toggles edit mode, toolbar buttons (insert/delete/move) post to `/save`, and changes are persisted back to source `.md` files on blur.

```
Browser                    Save Server                     Static Site Backend
   |                            |                                    |
   |-- GET /about ------------->|                                   |
   |                            |-- GET /about -------------------->|
   |                            |<-- HTML -------------------------|
   |                            |  [wrap blocks + inject HTMX]      |
   |<- HTML with editing UI ----|                                   |
   |   user clicks block ...    |                                   |
   |-- POST /save {blockId,...}-|-> writes to source .md file       |
   |<-- {ok:true, msg:"updated"}|                                   |
```

## Quick start

### CLI (recommended)

```bash
bunx markdown-blocks-server \
  --content-dir site/content \
  --preset zola \
  --port 9999 \
  --proxy http://localhost:1112 \
  --path-map '{"/_index.md":"/","/about/":"about.md"}'
```

The server reads `--content-dir`, annotates markdown files with block anchor comments on startup, and cleans them up on shutdown. Use `--preset` for SSG-specific content selectors and line counting (currently supports `generic`, `zola`, `hugo`).

### Programmatic

```ts
import { createSaveHandler } from 'markdown-blocks/server';

const handler = createSaveHandler({
  contentDir: '/path/to/markdown/files',
  preset: 'zola',
  pathMap: {
    '/':        '_index.md',
    '/about/':  'about.md',
  },
  backendProxyUrl: 'http://localhost:1112',   // your SSG dev server
});

Bun.serve({ port: 9999, fetch: handler });
```

`createSaveHandler` returns a standard `fetch(req) => Response` handler. It handles `/save`, `/source`, CORS preflight, and proxying all other requests to your backend with block ID injection. The client JavaScript is compiled from TypeScript at startup via `bun build` — no separate build step required.

### Installation (without npm publish)

```json
{
  "dependencies": {
    "markdown-blocks": "github:gtrak/markdown-blocks"
  }
}
```

Run `bun install` and Bun resolves the git URL automatically, pinning to a commit hash in `bun.lock`.

## Examples

Both examples use the CLI only — no custom TypeScript needed. Each demo site runs with two terminals: one for your SSG dev server, one for the markdown-blocks save server.

### Hugo

```bash
# Terminal 1
hugo server --port 1313

# Terminal 2
bunx markdown-blocks-server --content-dir content --preset hugo --proxy http://localhost:1313 --port 8765
```

Browse to **http://localhost:8765/** — see `example/hugo/` for details.

### Zola

```bash
# Terminal 1
zola serve --port 1111

# Terminal 2
bunx markdown-blocks-server --content-dir content --preset zola --proxy http://localhost:1111 --port 9999
```

Browse to **http://localhost:9999/** — see `example/zola/` for details.

## Client injection (automatic)

You do **not** need to add any client code to your templates. The server injects everything:

- **HTMX CDN** (`<script src="https://unpkg.com/htmx.org@2.0.4">`) before `</head>`
- **Editing CSS** (block borders, toolbar buttons, save indicator) before `</head>`
- **Client module** (`<script type="module" src="/mb-client.js">`) which is compiled from `src/client.ts` at server startup

The client activates via event delegation — clicking within a `.mb-block` toggles edit mode, and the floating toolbar handles insert/delete/move/delete operations through HTMX requests to `/save`.

## Named exports

| Export | Path | Description |
|--------|------|-------------|
| `createSaveHandler` | `markdown-blocks/server` | Server factory function |

## Save formats

**Block-level save** (preferred): updates only the changed block by line number, preserving everything else including frontmatter.

```json
{ "path": "/about/", "blockId": "h1-L2", "text": "New Heading" }
```

Setting `text` to an empty string deletes the block cleanly (heading + underline, or full paragraph).

**Full content save**: writes the entire HTML body back as Markdown. Preserves frontmatter from source. Use for non-block-level edits.

```json
{ "path": "/about/", "content": "<h1>Full new content...</h1>" }
```

## Save request format

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | URL path to resolve via pathMap (optional if using full filepath) |
| `filepath` | string | Full file path to .md source (alternative to path+pathMap) |
| `blockId` | string | Block ID like "h1-L2" (for block-level save) |
| `text` | string | New block text (with blockId, empty = delete) |
| `content` | string | Full HTML content (without blockId, writes to source) |

## Live editing workflow

The live editing session follows a clear setup → edit → teardown lifecycle. The server handles annotation and cleanup automatically.

### Session lifecycle

```
┌───────────── SETUP ─────────────┐
│ 1. Start your SSG dev server    │
│ 2. Start save server as proxy   │
│    (auto-annotates content .md)  │
│ 3. Browse to save server URL    │
├──────────── EDITING ────────────┤
│ • Click any block → edit mode   │
│ • Toolbar: insert, delete, move │
│ • Blur or Save button → persist │
│ • Reload page = instant refresh │
├─────────── TEARDOWN ────────────┤
│ 1. Stop save server (Ctrl+C)    │
│    (auto-deannotates content)   │
│ 2. Stop SSG dev server          │
│ 3. Content is clean .md again   │
└─────────────────────────────────┘
```

### What "annotation" means

On startup, the save server walks `contentDir` and injects comment anchors like `<!-- markdown-blocks:h1-0 -->` before each top-level block. These anchors let the server map HTML elements back to source file line numbers on every save.

On shutdown, all anchors are stripped — your `.md` files are left clean. If the server crashes, the next startup deannotates first before re-annotating.

### Step-by-step for Zola (typical example)

```bash
# Step 1: Start SSG (terminal A)
zola serve --port 1111

# Step 2: Start save server (terminal B)
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111 \
  --port 9999

# Step 3: Open http://localhost:9999 in browser
#   → Every block now has a subtle border and edit toolbar

# Editing:
#   Click a block → it becomes editable
#   Edit text → changes save to .md on blur
#   Use toolbar to insert new blocks, delete, or reorder

# Step 4: Done? Ctrl+C the save server
#   → Annotations are stripped automatically
#   → Your content/ is clean again
```

### Agent-assisted setup (Hermes, Claw, etc.)

An AI coding agent can automate the entire setup and teardown. The key parameters it needs are your SSG type and content directory. Typical agent workflow:

```
Agent receives: "enable live editing for my hugo site"
   │
   ▼
1. Detect SSG from project structure
     (looks for config.toml, zola.toml, _config.yml)
   │
   ▼
2. Start SSG dev server in background
     (hugo serve / zola serve)
   │
   ▼
3. Start save server as proxy in background
     (bunx markdown-blocks-server)
   │
   ▼
4. Report: "Live editing on http://localhost:9999"
     "Open this URL, click any block to edit"
   │
   ▼
5. On teardown request:
     Stop save server → annotations cleaned
     Stop SSG server
```

The agent doesn't need to manage annotations manually — `createSaveHandler` handles them in its setup and cleanup functions. For programmatic control:

```ts
import { createSaveHandler } from 'markdown-blocks/server';

// --- SETUP ---
const backend = Bun.spawn({ cmd: ['zola', 'serve', '--port', '1111'] });
await sleep(3000); // wait for SSG to start

const { handler, cleanup } = createSaveHandler({
  contentDir: 'content',
  preset: 'zola',
  backendProxyUrl: 'http://localhost:1111',
});

const server = Bun.serve({ port: 9999, fetch: handler });
console.log('Live editing: http://localhost:9999');

// --- TEARDOWN (when done) ---
server.stop();
cleanup();      // ← strips annotations from content/
backend.kill();
```

### Path mapping

If your SSG generates URLs that don't match file paths, use `--path-map`:

```bash
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111 \
  --port 9999 \
  --path-map '{"/":"/_index.md", "/about/":"about.md"}'
```

The path map tells the save server which URL maps to which content file — required when SSG routing differs from filesystem layout.

## Configuration reference
