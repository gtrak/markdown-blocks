import { test, expect } from "bun:test";
import { injectHtmxShells } from "../src/inject.js";
import { parseBlocks } from "../src/ast.js";
import { deannotate } from "../src/annotate.js";

// Realistic Zola HTML output: template adds <h1>{{ section.title }}</h1> BEFORE
// markdown content. Comments anchor the markdown blocks.
const rawZolaHtml = `<!DOCTYPE html>
<html><head><title>Page</title></head>
<body>
<main id="page-main">
<div class="content">
    <h1>Page</h1>
    <!-- markdown-blocks:h1-0 -->
<h1 id="page">Page</h1>
<!-- markdown-blocks:h1-1 -->
<h1 id="page-1">Page</h1>
<!-- markdown-blocks:h1-2 -->
<h1 id="sloplab">SlopLab</h1>
<!-- markdown-blocks:p-0 -->
<p>InstallView on GitHubRead Docs</p>
</div>
</main>
</body></html>`;

const sourceMd = `+++
title = "Page"
+++
<!-- markdown-blocks:h1-0 -->
Page
====

<!-- markdown-blocks:h1-1 -->
Page
====

<!-- markdown-blocks:h1-2 -->
SlopLab
=======

<!-- markdown-blocks:p-0 -->
InstallView on GitHubRead Docs
`;

test("injectHtmxShells anchors on comments, wraps correct elements", () => {
  const blocks = parseBlocks(deannotate(sourceMd));
  expect(blocks.length).toBe(4); // h1-0, h1-1, h1-2, p-0

  const result = injectHtmxShells(rawZolaHtml, blocks, "main", "/");

  // Count shells
  const shellIds = Array.from(result.matchAll(/data-block-id="([^"]+)"/g)).map(m => m[1]);
  console.log("Shell IDs:", shellIds);

  // Verify no duplicates
  expect(new Set(shellIds).size).toBe(shellIds.length);
  expect(shellIds.length).toBe(blocks.length);

  // Verify each shell wraps the correct element by checking innerHTML content
  for (const shellId of shellIds) {
    // Find this shell in the result
    const shellStart = result.indexOf(`data-block-id="${shellId}"`);
    expect(shellStart).toBeGreaterThan(-1);

    // Extract innerHTML between mb-content open and its close
    const contentStart = result.indexOf('class="mb-content"', shellStart);
    const tagClose = result.indexOf('>', contentStart) + 1;
    const contentEnd = result.indexOf('</div>', tagClose);
    const innerHtml = result.slice(tagClose, contentEnd).trim();

    console.log(`${shellId} innerHtml: "${innerHtml.substring(0, 60)}"`);

    // Should contain actual content, not empty
    expect(innerHtml.length).toBeGreaterThan(0);
  }

  // Verify template h1 is NOT wrapped (it has no comment anchor)
  const templateH1Index = result.indexOf('<h1>Page</h1>');
  const firstShellIndex = result.indexOf('class="mb-block"');
  expect(templateH1Index).toBeLessThan(firstShellIndex);
});
