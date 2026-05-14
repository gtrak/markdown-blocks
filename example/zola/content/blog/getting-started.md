+++
title = "Getting Started with Markdown Blocks"
date = 2025-06-15
description = "How to use markdown-blocks for inline editing"

[taxonomies]
tags = ["tutorial", "blocks"]

[sitemap]
priority = 0.9
+++

## Prerequisites

You'll need:
1. Zola installed on your system
2. Bun runtime (for the save server)
3. A working Zola site with markdown content

## How it works

The markdown-blocks save server sits between your browser and Zola's dev server as a proxy:

```
Browser → Save Server (port 9999) → Zola (port 1111)
```

When you make edits, they're saved directly to your `.md` files.

## Running it

Start both servers:

```bash
zola serve --port 1111          # Terminal 1
bunx markdown-blocks-server \
  --content-dir content \
  --preset zola \
  --proxy http://localhost:1111  # Terminal 2
```

Then browse to **http://localhost:9999/** and start editing!
