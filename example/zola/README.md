# Markdown Blocks — Zola Demo

This is a minimal Zola project configured with markdown-blocks inline editing.

## Prerequisites

- [Zola](https://www.getzola.org/) installed
- Bun runtime (for the save server)

## Quick Start

```bash
# Terminal 1: Start Zola's dev server
zola serve --port 1111

# Terminal 2: Start markdown-blocks save server
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111 \
  --port 9999
```

Then browse to **http://localhost:9999/** — this is the markdown-blocks proxy, not Zola directly.

## How It Works

1. Your browser requests pages from port 9999 (save server)
2. The save server proxies each request to Zola on port 1111
3. On the response, it injects HTMX-powered edit shells around each markdown block
4. When you edit and click away, the save server writes changes back to `content/`
5. Zola picks up the file changes and re-renders

## File Structure

```
example/zola/
├── config.toml        # Zola configuration
├── templates/         # Tera templates
│   ├── base.html      # Base layout
│   ├── index.html     # Home page template
│   └── page.html      # Single page template
├── content/           # Your markdown files (what you'll edit)
│   ├── _index.md      # Home page content
│   └── blog/
│       ├── _index.md          # Blog section index
│       ├── hello-world.md     # First post
│       └── getting-started.md # Second post
└── README.md          # This file
```

No custom TypeScript needed — the save server CLI handles everything.
