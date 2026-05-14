---
title: "markdown-blocks"
description: "Block-level Markdown editing API with client-side integration"
draft: false
---

# = markdown-blocks

Bun runtime package that adds block-level in-browser editing to any static Markdown site. Server assigns stable block IDs from source file line numbers, client sends edits back by block ID.

## How it works

The server intercepts page requests and injects `data-block-id` attributes into HTML elements. The client listens on those elements, collects edits, and POSTs them to `/save`.

```
Browser                    Save Server                     Static Site Backend
   |                            |                                    |
   |-- GET /about ------------->|                                   |
   |                            |-- GET /about -------------------->|
   |                            |<-- HTML -------------------------|
   |                            |  [inject data-block-id]           |
   |<- HTML with block IDs -----|                                   |
   |   user edits heading ...   |                                   |
   |-- POST /save {blockId,...}-|-> writes to source .md file       |
   |<-- {ok:true, msg:"updated"}|                                   |
```

## API

### Server (Bun runtime)

```ts
import { createSaveHandler } from 'markdown-blocks';

const handler = createSaveHandler({
  contentDir: '/path/to/markdown/files',     // directory containing .md source files
  pathMap: {
    // URL path → filename inside contentDir
    '/':        '_index.md',
    '/about/':  'about.md',
  },
  backendProxyUrl: 'http://localhost:1112',   // your static site dev server
});

Bun.serve({ port: 9999, fetch: handler });
```

`createSaveHandler` returns a standard `fetch(req) => Response` handler. It handles `/save` (block-level and full-content saves), CORS preflight, and proxying all other requests to your backend with block ID injection.

### Client (vanilla JS, no dependencies)

Add this script to every page served through the save server:

```html
<script>
var main = document.querySelector('main') || document.body;
function debounce(fn, ms){ var t; return function(){ clearTimeout(t); t=setTimeout(fn.bind(this), ms) }; }
main.querySelectorAll('h1,h2,h3,h4,h5,h6,p').forEach(function(block){
  var id = block.getAttribute('data-block-id');
  if (!id) return;
  block.setAttribute('contenteditable', 'true');
  block.addEventListener('input', debounce(function(){
    fetch('/save', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path:'[[ page.path ]]', blockId: id, text: block.innerText })
    })
  }, 300));
});
</script>
```

Replace `[[ page.path ]]` with the actual URL path. Each template language has its own syntax:
- **Zola**: `{{ page.path }}`
- **Hugo**: `.RelPermalink` or `.Page.Permalink` (trimmed)
- **Jekyll**: `{{ page.url }}`

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
