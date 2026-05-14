# Markdown Blocks — Hugo Demo

This is a minimal Hugo project configured with markdown-blocks inline editing.

## Prerequisites

- [Hugo](https://gohugo.io/) installed
- Bun runtime (for the save server)

## Quick Start

```bash
# Terminal 1: Start Hugo's dev server
cd example/hugo
hugo server --port 1313

# Terminal 2: Start the markdown-blocks save server (from project root)
bn run build
bun example/hugo/save-server.ts
```

Then browse to **http://localhost:8765/** — this is the markdown-blocks proxy,
not Hugo directly.

## How It Works

1. Your browser requests pages from port 8765 (save server)
2. The save server proxies each request to Hugo on port 1313
3. On the response, it injects HTMX-powered edit shells around each markdown block
4. When you edit and click away, the save server writes changes back to `content/`
5. Hugo picks up the file changes and re-renders (livereload)

## File Structure

```
example/hugo/
├── hugo.toml          # Hugo configuration
├── layouts/           # Hugo templates
│   ├── index.html     # Home page template
│   └── _default/
│       ├── baseof.html  # Base layout
│       └── single.html  # Single page layout
├── content/           # Your markdown files (what you'll edit)
│   ├── _index.md      # Home page content
│   └── blog/
│       ├── _index.md          # Blog section index
│       ├── hello-world.md     # First post
│       └── getting-started.md # Second post
├── save-server.ts     # Save server entry point
└── README.md          # This file
```

## Comment Passthrough

Hugo renders HTML comments by default, so the `<!-- markdown-blocks:... -->` anchors
work out of the box. No special Hugo configuration needed.

If you're using a custom Goldmark renderer or have disabled raw HTML passthrough,
enable it in `hugo.toml`:

```toml
[markup.goldmark.renderer]
  unsafe = true
```
