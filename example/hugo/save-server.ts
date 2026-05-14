/**
 * Markdown Blocks — Hugo Demo Save Server
 *
 * This server sits in front of Hugo's dev server, intercepting page loads to inject
 * edit-mode HTML shells around each block. When you click a block and make changes,
 * this server saves them back to your .md files.
 *
 * Usage:
 *   1. Start Hugo:     hugo server (port 1313)
 *   2. Start this:     bun save-server.ts
 *   3. Browse to:      http://localhost:8765/
 */

import { createSaveHandler } from "markdown-blocks/server";

Bun.serve({
  port: 8765,
  fetch: createSaveHandler({
    contentDir: "./content",
    preset: "hugo",
    backendProxyUrl: "http://localhost:1313",
  }),
});

console.log("markdown-blocks save server running on http://localhost:8765");
console.log("(Make sure Hugo is also running on port 1313)");
