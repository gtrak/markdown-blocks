import { Block, formatBlockId } from "./types.js";
import * as parse5 from "parse5";
import { escapeHtml } from "./render.js";
import { parseHtml as parse5Parse, serialize as parse5Serialize, findCommentAnchors, findElementBySelector, isBlockTag, replaceParent, insertBefore } from "./inject_dom.js";

/**
 * Build just the inner content (mb-content + mb-bar) without the outer mb-block wrapper.
 * Used for HTMX innerHTML swaps into an existing .mb-block target.
 */
/** Build just the .mb-content div (no toolbar) for innerHTML swap into existing block. */
export function buildHtmxContentInner(blockId: string, innerHtml: string, pagePath: string): string {
  return `
<div class="mb-content"
     hx-get="/source"
     hx-target="this"
     hx-swap="outerHTML"
     hx-trigger="click"
     hx-vals='{"blockId":"${blockId}","path":"${pagePath}"}'>
  ${innerHtml}
</div>`;
}

export function buildHtmxShellInner(blockId: string, innerHtml: string, isList: boolean, pagePath: string): string {
  return `
<div class="mb-content"
     hx-get="/source"
     hx-target="this"
     hx-swap="outerHTML"
     hx-trigger="click"
     hx-vals='{"blockId":"${blockId}","path":"${pagePath}"}'>
  ${innerHtml}
</div>`;
}

/**
 * Build the htmx shell HTML for a single block.
 */
export function buildHtmxShell(blockId: string, innerHtml: string, isList: boolean, pagePath: string): string {
  // Two-pane block shell: click fetches raw source via GET /source,
  // blur submits raw markdown via POST /save.
  return `
<div class="mb-block" data-block-id="${blockId}">
  <div class="mb-content"
       hx-get="/source"
       hx-target="this"
       hx-swap="outerHTML"
       hx-trigger="click"
       hx-vals='{"blockId":"${blockId}","path":"${pagePath}"}'>
    ${innerHtml}
  </div>
  <div class="mb-bar" data-mb-block-id="${blockId}">
    <button type="button" data-mb-action="insert" data-mb-block-id="${blockId}">+</button>
    <button type="button" data-mb-action="delete" data-mb-block-id="${blockId}">🗑</button>
    <button type="button" data-mb-move="up" data-mb-block-id="${blockId}">↑</button>
    <button type="button" data-mb-move="down" data-mb-block-id="${blockId}">↓</button>
  </div>
</div>`;
}

const P5T = parse5.defaultTreeAdapter;

/** Serialize a single parse5 Element (with all children) to an HTML string. */
function serializeElement(elem: parse5.Element): string {
  const tag = P5T.getTagName(elem);
  const attrs = P5T.getAttrList(elem).map(a => ` ${a.name}="${a.value}"`).join("");
  const children = P5T.getChildNodes(elem).map(n => serializeNodeInner(n)).join("");
  return `<${tag}${attrs}>${children}</${tag}>`;
}

function serializeNodeInner(node: parse5.Node): string {
  if (P5T.isElementNode(node)) return serializeElement(node as parse5.Element);
  if (P5T.isTextNode(node)) return escapeHtml(P5T.getTextNodeContent(node));
  if (P5T.isCommentNode(node)) return `<!--${P5T.getCommentNodeContent(node)}-->`;
  return "";
}

/**
 * Inject htmx shell wrappers around each block element in the HTML.
 *
 * Matches blocks by their `<!-- markdown-blocks:tag-index -->` comment
 * anchors — NOT by tag occurrence count. This avoids misalignment when
 * the SSG template injects extra headings before the markdown content.
 *
 * Works within a content selector scope (default "main").
 */
export function injectHtmxShells(html: string, blocks: Block[], contentSelector: string = "main", pagePath: string = "/"): string {
  if (blocks.length === 0) return html;

  // Parse full document
  const doc = parse5Parse(html);

  // Find content area
  const contentArea = findElementBySelector(doc, contentSelector);
  const searchRoot = contentArea || findElementBySelector(doc, "body") || null;
  if (!searchRoot) return html;

  // Build set of expected block IDs from the parsed markdown blocks
  const expectedIds = new Set(blocks.map(b => formatBlockId({ tag: b.tag, index: b.index })));

  // Find all comment anchors within content area
  const anchors = findCommentAnchors(searchRoot);

  // Collect targets: anchors whose next element is a recognized block tag
  // AND whose blockId matches an expected block ID
  const targets: Array<{ anchorNode: parse5.CommentNode; targetEl: parse5.Element; blockId: string }> = [];
  for (const a of anchors) {
    if (!a.nextElement) continue;
    const tagName = P5T.getTagName(a.nextElement).toLowerCase();
    if (isBlockTag(tagName) && expectedIds.has(a.blockId)) {
      targets.push({ anchorNode: a.commentNode, targetEl: a.nextElement, blockId: a.blockId });
    }
  }

  // If no comment anchors found, fall back to occurrence-count mode for plain HTML
  if (targets.length === 0) {
    return injectHtmxShellsOccurrenceMode(html, blocks, contentSelector, pagePath);
  }

  // Process targets in REVERSE document order (last first) so that replacing
  // earlier elements doesn't invalidate positions of later ones
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    const tagName = P5T.getTagName(t.targetEl).toLowerCase();
    const isList = ["ul", "ol"].includes(tagName);

    // Serialize the original element for inclusion in shell
    const elementHtml = serializeElement(t.targetEl);

    // Build htmx shell HTML
    const shellHtml = buildHtmxShell(t.blockId, elementHtml, isList, pagePath);

    // Parse shell into a DOM node
    const fragment = parse5.parseFragment(shellHtml);
    // Find the first element child (skip whitespace text nodes from leading newlines)
    let shellNode: parse5.Element | null = null;
    for (const child of P5T.getChildNodes(fragment)) {
      if (P5T.isElementNode(child)) {
        shellNode = child as parse5.Element;
        break;
      }
    }
    if (!shellNode) continue;

    // Replace the original element with its shell wrapper
    replaceParent(t.targetEl, shellNode);

    // Remove the comment anchor
    const anchorParent = P5T.getParentNode(t.anchorNode);
    if (anchorParent) {
      P5T.detachNode(t.anchorNode);
    }
  }

  return parse5Serialize(doc);
}

/** Fallback mode for plain HTML without comment anchors (used by test fixtures). */
function injectHtmxShellsOccurrenceMode(html: string, blocks: Block[], contentSelector: string, pagePath: string): string {
  const doc = parse5Parse(html);

  const contentArea = findElementBySelector(doc, contentSelector);
  const searchRoot = contentArea || findElementBySelector(doc, "body") || null;
  if (!searchRoot) return html;

  // Collect top-level blocks and build a map from tag -> expected indices
  const topLevelBlocks = blocks.filter(b => b.itemIndex === undefined);
  const blockIndices = new Map<string, number[]>();
  for (const b of topLevelBlocks) {
    if (!blockIndices.has(b.tag)) blockIndices.set(b.tag, []);
    blockIndices.get(b.tag)!.push(b.index);
  }

  // Collect all target elements in document order
  const tagCounts = new Map<string, number>();
  const targets: Array<{ el: parse5.Element; blockId: string }> = [];

  function collect(node: parse5.Node) {
    if (!P5T.isElementNode(node)) return;
    const el = node as parse5.Element;
    const tagName = P5T.getTagName(el).toLowerCase();
    if (isBlockTag(tagName)) {
      let count = tagCounts.get(tagName) || 0;
      const indices = blockIndices.get(tagName);
      if (indices && indices[count] !== undefined) {
        targets.push({ el, blockId: formatBlockId({ tag: tagName, index: count }) });
      }
      tagCounts.set(tagName, count + 1);
    }
    for (const child of P5T.getChildNodes(el)) {
      collect(child);
    }
  }

  collect(searchRoot as parse5.Node);

  // Wrap each target element with a shell (reverse order to avoid invalidating positions)
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    const tagName = P5T.getTagName(t.el).toLowerCase();
    const isList = ["ul", "ol"].includes(tagName);

    const elementHtml = serializeElement(t.el);
    const shellHtml = buildHtmxShell(t.blockId, elementHtml, isList, pagePath);

    // Parse shell HTML into a DOM fragment and find the first element child
    const fragment = parse5.parseFragment(shellHtml);
    let shellNode: parse5.Element | null = null;
    for (const child of P5T.getChildNodes(fragment)) {
      if (P5T.isElementNode(child)) {
        shellNode = child as parse5.Element;
        break;
      }
    }
    if (!shellNode) continue;

    replaceParent(t.el, shellNode);
  }

 return parse5Serialize(doc);
}

/**
 * Inject a self-contained dismissible banner for pages whose markdown source
 * was not found.  The script sets `data-uneditable-banner="1"` on `<html>`
 * as an idempotency guard so repeated calls do not produce duplicate banners.
 */
export function injectUneditableBanner(html: string): string {
  const doc = parse5Parse(html);

  // Idempotency: skip if already injected (check via DOM)
  const htmlEl = findElementBySelector(doc, "html");
  if (htmlEl && P5T.getAttrList(htmlEl).some(a => a.name === "data-uneditable-banner")) {
    return html;
  }

  // Set idempotency attribute on <html>
  if (htmlEl) {
    htmlEl.attrs.push({ name: "data-uneditable-banner", value: "1" });
  }

  const bannerScript = `<script>
(function(){document.documentElement.setAttribute('data-uneditable-banner','1');var d=document.createElement('div');d.id='mb-uneditable';d.style.cssText='position:fixed;top:0;left:0;right:0;background:#fef3c7;border-bottom:2px solid #f59e0b;color:#92400e;padding:10px 40px 10px 16px;font-size:13px;line-height:1.4;z-index:2147483647;font-family:sans-serif';d.textContent='No markdown source found for this page. Add it to your contentDir or define a pathMap entry in markdown-blocks.config.ts.';var b=document.createElement('button');b.textContent='\u00d7';b.style.cssText='position:absolute;top:8px;right:12px;border:none;background:transparent;font-size:18px;cursor:pointer;color:#92400e';b.onclick=function(){document.body.removeChild(d)};d.appendChild(b);document.body.insertBefore(d,document.body.firstChild)})();
<\/script>`;

  // Insert near top of <body>
  const body = findElementBySelector(doc, "body");
  if (body) {
    const fragment = parse5.parseFragment(bannerScript);
    const firstChild = P5T.getChildNodes(body)[0];
    if (firstChild) {
      for (const child of P5T.getChildNodes(fragment)) {
        insertBefore(body, child, firstChild);
      }
    } else {
      for (const child of P5T.getChildNodes(fragment)) {
        P5T.appendChild(body, child);
      }
    }
  }

  return parse5Serialize(doc);
}


/** CSS styles for the markdown-blocks editing UI, injected before </head>. */
const HTMX_CLIENT_CSS = `<style>
.mb-block{position:relative;margin:4px 0;padding:4px;border:1px solid transparent;border-radius:4px}
.mb-block:hover{border-color:#333}
.mb-block.mb-editing{border-color:#4a9eff}

.mb-block.mb-editing .mb-bar{display:none}
.mb-floater .mb-bar{display:flex;position:static}
.mb-content{padding:4px;min-height:1.5em}
.mb-source{width:100%;padding:4px;border:1px solid #4a9eff;border-radius:4px;font-size:14px;resize:none;font-family:inherit;line-height:1.5}
.mb-floater{position:fixed;display:flex;gap:4px;padding:4px;background:rgba(0,0,0,0.7);border-radius:6px;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,0.3)}
.mb-bar{display:none;position:absolute;top:4px;right:4px;gap:2px;padding:2px;background:rgba(0,0,0,0.7);border-radius:4px;z-index:100}
.mb-bar button,.mb-bar summary{width:36px;height:36px;border:none;background:#555;color:#fff;border-radius:3px;font-size:14px;cursor:pointer;text-align:center;line-height:36px;list-style:none}
.mb-bar button:hover,.mb-bar summary:hover{background:#777}
#save-indicator{position:fixed;bottom:12px;right:12px;background:#333;color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;font-family:sans-serif;opacity:0;transition:opacity .3s;z-index:999}
#save-indicator.show{opacity:1}
</style>`;

/** htmx CDN script, injected before </head>. */
const HTMX_CLIENT_SCRIPT_CDN = `<script src="https://unpkg.com/htmx.org@2.0.4" crossorigin="anonymous"></script>`;

/** htmx bundled script (local), injected before </head>. */
const HTMX_CLIENT_SCRIPT_BUNDLED = `<script src="/htmx.min.js"></script>`;

/** Standalone client module, injected just before </body>. */
const HTMX_CLIENT_BODY = `<script type="module" src="/mb-client.js"></script>`;

/**
 * Inject the htmx client runtime (CDN script, CSS, save indicator) into
 * the raw HTML response from the upstream SSG.  Idempotent: safe to call
 * on already-injected HTML.
 */
export function injectHtmxClient(html: string, htmxSource: "cdn" | "bundled" = "cdn"): string {
  const script = htmxSource === "bundled" ? HTMX_CLIENT_SCRIPT_BUNDLED : HTMX_CLIENT_SCRIPT_CDN;

  // Fast idempotency guard — skip if already processed
  if (html.includes("data-mb-client")) return html;

  const doc = parse5Parse(html);

  // Find <html>, <head>, <body> elements
  const htmlEl = findElementBySelector(doc, "html");
  const head = findElementBySelector(doc, "head");
  const body = findElementBySelector(doc, "body");

  // Set idempotency attribute on <html>
  if (htmlEl) {
    htmlEl.attrs.push({ name: "data-mb-client", value: "1" });
  }

  // Inject CSS + htmx script into <head>
  if (head) {
    const headInjection = parse5.parseFragment(script + "\n" + HTMX_CLIENT_CSS);
    for (const child of P5T.getChildNodes(headInjection)) {
      P5T.appendChild(head, child);
    }
  }

  // Inject save-indicator script into <body> (at end)
  if (body) {
    const bodyInjection = parse5.parseFragment(HTMX_CLIENT_BODY);
    for (const child of P5T.getChildNodes(bodyInjection)) {
      P5T.appendChild(body, child);
    }
  }

  return parse5Serialize(doc);
}
