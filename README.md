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
