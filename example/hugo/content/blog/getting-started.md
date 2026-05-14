---
title: "Getting Started with Static Site Editing"
date: 2024-01-20
description: "How to set up inline editing for your Hugo site"
tags: ["tutorial", "hugo"]
---

Setting up inline editing on your own Hugo site takes just a few steps.

## Step 1: Install the Package

Add `markdown-blocks` to your project dependencies using your package manager of choice.

## Step 2: Configure the Save Server

Create a save server configuration that points to your content directory and proxies through to Hugo's dev server.

```typescript
import { createSaveHandler } from "markdown-blocks/server";

Bun.serve({
  port: 8765,
  fetch: createSaveHandler({
    contentDir: "./content",
    preset: "hugo",
    backendProxyUrl: "http://localhost:1313",
  }),
});
```

## Step 3: Run Both Servers

Run Hugo's dev server first, then the save server. Browse to port 8765 to start editing.
