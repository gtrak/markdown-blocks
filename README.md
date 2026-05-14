---
title: "markdown-blocks"
description: "Block-level in-browser editing for static Markdown sites"
draft: false
---

# markdown-blocks

Add inline block editing to any static Markdown site. Drop a save server in front of your existing Zola, Hugo, or other SSG dev server — every paragraph, heading, and list on the page becomes editable right in the browser, with changes saved back to your `.md` source files.

## How it works

The save server sits between you and your static site generator as a reverse proxy:

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

The server annotates your content files with invisible comment anchors on startup (and strips them on shutdown), so edits made in the browser map back to exact line numbers in source. Crash-safe: if the server dies unexpectedly, the next startup cleans up before re-annotating.

No template changes needed — everything is injected automatically into proxied HTML responses.

## Session lifecycle

```
┌────────── SETUP ──────────┐
│ 1. Start your SSG server  │
│ 2. Start save server      │
│    (auto-annotates .md)   │
│ 3. Browse to save server  │
├────────── EDITING ────────┤
│ • Click any block → edit  │
│ • Toolbar: insert, delete │
│ • Blur or Save → persist  │
├───────── TEARDOWN ────────┤
│ 1. Stop save server       │
│    (auto-cleans .md)      │
│ 2. Stop SSG server        │
│ 3. Content is clean again │
└───────────────────────────┘
```

## Quick start

### 1. Install

```json
{
  "dependencies": {
    "markdown-blocks": "github:gtrak/markdown-blocks"
  }
}
```

Run `bun install`. No npm publish required — Bun resolves the git URL and pins to a commit hash.

### 2. Start your SSG server (Terminal A)

```bash
zola serve --port 1111
# or: hugo server --port 1313
```

### 3. Start the save server (Terminal B)

```bash
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111 \
  --port 9999
```

### 4. Open `http://localhost:9999` in your browser

Every block is now editable. Click to edit, use the toolbar to insert/delete/reorder blocks, and changes persist back to source files on blur.

When you're done, stop both servers — annotations are cleaned up automatically.

## AI agent integration

An AI coding agent (Hermes, Claw, etc.) can automate setup and teardown. The only information needed is your SSG type and content directory:

```
"enable live editing for my hugo site"
   │
   ▼
1. Detect SSG from project structure
2. Start SSG dev server in background
3. Start save server as proxy in background
4. Report: "Live editing on http://localhost:9999"
5. On teardown: stop both, annotations cleaned
```

For programmatic control:

```ts
import { createSaveHandler } from 'markdown-blocks/server';

const backend = Bun.spawn({ cmd: ['zola', 'serve', '--port', '1111'] });
await new Promise(r => setTimeout(r, 3000));

const { handler, cleanup } = createSaveHandler({
  contentDir: 'content',
  preset: 'zola',
  backendProxyUrl: 'http://localhost:1111',
});

const server = Bun.serve({ port: 9999, fetch: handler });
console.log('Live editing: http://localhost:9999');

// Teardown when done:
server.stop();
cleanup();      // strips annotations
backend.kill();
```

## CLI options

| Flag | Description | Default |
|------|-------------|---------|
| `--content-dir` | Path to your Markdown source files | required |
| `--preset` | SSG preset: `generic`, `zola`, `hugo` | `generic` |
| `--proxy` | URL of your SSG dev server | — |
| `--port` | Port for the save server | `9999` |
| `--path-map` | JSON map of URL path → filename | auto-detected |

### Path mapping

Use `--path-map` when your SSG URLs don't match filesystem paths:

```bash
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111 \
  --port 9999 \
  --path-map '{" /":"/_index.md","/about/":"about.md"}'
```

## Programmatic API

```ts
import { createSaveHandler } from 'markdown-blocks/server';

const { handler, cleanup } = createSaveHandler({
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

`createSaveHandler` returns a standard `fetch(req) => Response` handler plus a cleanup function. No build step required — the client JavaScript is compiled from TypeScript at startup via `bun build`.

## Examples

Both examples in `example/` use the CLI only — no custom code needed:

| Site   | Command                                                     |
|--------|-------------------------------------------------------------|
| Hugo   | `bunx markdown-blocks-server --content-dir content --preset hugo --proxy http://localhost:1313 --port 8765` |
| Zola   | `bunx markdown-blocks-server --content-dir content --preset zola --proxy http://localhost:1111 --port 9999` |
