/**
 * render.ts — Convert a single markdown block (or small document) into an HTML fragment.
 *
 * This is intentionally minimal: it walks an mdast tree and produces HTML strings
 * directly, avoiding the full unified/rehype pipeline.  Only block-level elements
 * that appear in typical SSG output are supported (headings, paragraphs, lists,
 * blockquotes, code blocks, thematic breaks, inline emphasis/strong/links/code).
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import type { Node, Root } from "mdast";

/** Escape HTML special characters so raw text is safe for innerHTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderChildren(parent: { children?: Node[] }): string {
  if (!parent.children) return "";
  return parent.children.map(renderNode).join("");
}

function renderAttrs(attrs: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) {
      parts.push(`${k}="${escapeHtml(v)}"`);
    }
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function renderNode(node: Node): string {
  // If node is an mdast "Parent" with children, fall through below.
  switch (node.type) {
    case "heading": {
      const h = node as { depth: number };
      const tag = `h${h.depth}`;
      return `<${tag}>${renderChildren(node as unknown as { children: Node[] })}</${tag}>`;
    }
    case "paragraph":
      return `<p>${renderChildren(node as unknown as { children: Node[] })}</p>`;
    case "blockquote":
      return `<blockquote>${renderChildren(node as unknown as { children: Node[] })}</blockquote>`;
    case "list": {
      const l = node as { ordered: boolean; start?: number };
      const tag = l.ordered ? "ol" : "ul";
      const startAttr = l.ordered && l.start !== undefined && l.start !== 1 ? ` start="${l.start}"` : "";
      return `<${tag}${startAttr}>${renderChildren(node as unknown as { children: Node[] })}</${tag}>`;
    }
    case "listItem": {
      const li = node as { checked?: boolean | null; children: Node[] };
      const checkedAttr = li.checked === true ? ' data-checked="true"' : li.checked === false ? ' data-checked="false"' : "";
      // Unwrap single paragraph child for tight lists (common markdown convention)
      if (li.children.length === 1 && li.children[0].type === "paragraph") {
        const para = li.children[0] as unknown as { children: Node[] };
        return `<li${checkedAttr}>${renderChildren(para)}</li>`;
      }
      return `<li${checkedAttr}>${renderChildren(li)}</li>`;
    }
    case "code": {
      const c = node as { value: string; lang?: string };
      const langAttr = c.lang ? ` class="language-${escapeHtml(c.lang)}"` : "";
      return `<pre><code${langAttr}>${escapeHtml(c.value)}</code></pre>`;
    }
    case "thematicBreak":
      return "<hr>";

    // Inline nodes
    case "text": {
      const t = node as { value: string };
      return escapeHtml(t.value);
    }
    case "strong":
      return `<strong>${renderChildren(node as unknown as { children: Node[] })}</strong>`;
    case "emphasis":
      return `<em>${renderChildren(node as unknown as { children: Node[] })}</em>`;
    case "inlineCode": {
      const c = node as { value: string };
      return `<code>${escapeHtml(c.value)}</code>`;
    }
    case "link": {
      const a = node as { url: string; title?: string; children: Node[] };
      const attrs: Record<string, string> = { href: a.url };
      if (a.title) attrs.title = a.title;
      const attrStr = renderAttrs(attrs);
      return `<a${attrStr}>${renderChildren(a)}</a>`;
    }
    case "break":
      return "<br>";
    case "image": {
      const img = node as { url: string; alt?: string; title?: string };
      const attrs: Record<string, string> = { src: img.url };
      if (img.alt !== undefined) attrs.alt = img.alt;
      if (img.title) attrs.title = img.title;
      const attrStr = renderAttrs(attrs);
      return `<img${attrStr}>`;
    }
    default:
      // Unknown node type: try to render children, or return empty string for leaf nodes
      if ("children" in node && Array.isArray((node as Record<string, unknown>).children)) {
        return renderChildren(node as unknown as { children: Node[] });
      }
      return "";
  }
}

/**
 * Parse a markdown string and render the **first non-frontmatter block node**
 * as an HTML fragment string.
 *
 * Useful for returning an HTML snippet from a server after an insert/update
 * so htmx can swap it into the DOM directly.
 */
export function renderBlock(source: string): string {
  const tree = fromMarkdown(source) as Root;

  for (const child of tree.children) {
    // Skip YAML/TOML frontmatter
    if (child.type === "yaml" || child.type === "toml") continue;
    return renderNode(child as unknown as Node);
  }

  return "";
}
