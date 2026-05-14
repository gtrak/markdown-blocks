/**
 * DOM-tree-based HTML manipulation utilities powered by parse5.
 * Replaces fragile string-level regex parsing with proper DOM tree operations.
 */

import * as parse5 from "parse5";

const T = parse5.defaultTreeAdapter;

// ---------------------------------------------------------------------------
// Parse / serialize helpers
// ---------------------------------------------------------------------------

/** Parse an HTML string into a parse5 Document tree. */
export function parseHtml(html: string): parse5.Document {
  return parse5.parse(html);
}

/** Serialize a parse5 Document back to an HTML string. */
export function serialize(doc: parse5.Document): string {
  return parse5.serialize(doc);
}

// ---------------------------------------------------------------------------
// Type guards (wrappers around the tree adapter)
// ---------------------------------------------------------------------------

function isElementNode(node: parse5.Node): node is parse5.Element {
  return T.isElementNode(node);
}

function isCommentNode(node: parse5.Node): node is parse5.CommentNode {
  return T.isCommentNode(node);
}

// ---------------------------------------------------------------------------
// Comment anchor detection
// ---------------------------------------------------------------------------

/** Matches `markdown-blocks:BLOCK_ID` in comment content (with optional leading/trailing whitespace). */
const ANCHOR_RE = /^\s*markdown-blocks:(\S+)\s*$/;

/** Walk the tree in document order and find all HTML comments matching the
 * `markdown-blocks:BLOCK_ID` pattern, returning each anchor's blockId and
 * the immediately following element sibling (if any). */
export function findCommentAnchors(
  root: parse5.Element,
): Array<{ commentNode: parse5.CommentNode; blockId: string; nextElement: parse5.Element | null }> {
  const results: Array<{
    commentNode: parse5.CommentNode;
    blockId: string;
    nextElement: parse5.Element | null;
  }> = [];

  function walk(node: parse5.Node) {
    if (isElementNode(node)) {
      for (const child of T.getChildNodes(node)) {
        if (isCommentNode(child)) {
          const content = T.getCommentNodeContent(child);
          const match = ANCHOR_RE.exec(content);
          if (match) {
            // Find the next sibling that is an element (skip text/whitespace nodes)
            const siblings = T.getChildNodes(T.getParentNode(child)!);
            let nextEl: parse5.Element | null = null;
            for (let i = 0; i < siblings.length; i++) {
              if (siblings[i] === child) {
                // Scan forward from position after this comment
                for (let j = i + 1; j < siblings.length; j++) {
                  if (isElementNode(siblings[j])) {
                    nextEl = siblings[j] as parse5.Element;
                    break;
                  }
                }
                break;
              }
            }
            results.push({ commentNode: child, blockId: match[1], nextElement: nextEl });
          }
        } else if (isElementNode(child)) {
          walk(child);
        }
      }
    }
  }

  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Element lookup
// ---------------------------------------------------------------------------

/** Find an element whose tag name matches `selector` (case-insensitive).
 * Performs a simple DFS from the document root. */
export function findElementBySelector(
  root: parse5.Document,
  selector: string,
): parse5.Element | null {
  const target = selector.toLowerCase();

  function search(node: parse5.Node): parse5.Element | null {
    if (isElementNode(node) && T.getTagName(node).toLowerCase() === target) {
      return node;
    }
    const children = T.getChildNodes(node);
    if (!children) return null;
    for (const child of children) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  }

  return search(root);
}

// ---------------------------------------------------------------------------
// Block tag detection
// ---------------------------------------------------------------------------

/** Check if a tag name is one of the recognised block-level tags. */
export function isBlockTag(tagName: string): boolean {
  const tag = tagName.toLowerCase();
  return ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote"].includes(tag);
}

// ---------------------------------------------------------------------------
// Tree manipulation
// ---------------------------------------------------------------------------

/** Find the parent of `child` and replace it with `replacement`.
 * Returns false if no parent is found (root-level node). */
export function replaceParent(
  child: parse5.Element | parse5.CommentNode,
  replacement: parse5.Element,
): boolean {
  const parent = T.getParentNode(child);
  if (!parent) return false;

  // Insert the replacement at the same position as the child
  T.insertBefore(parent, replacement, child);
  T.detachNode(child);
  return true;
}

// ---------------------------------------------------------------------------
// Child collection
// ---------------------------------------------------------------------------

/** Return only direct element children (not text or comment nodes). */
function getDirectChildren(el: parse5.Element): parse5.Element[] {
  const children = T.getChildNodes(el);
  return children.filter(isElementNode) as parse5.Element[];
}

// ---------------------------------------------------------------------------
// Recursive element search
// ---------------------------------------------------------------------------

/** Recursively find all elements of a given tag name in document order. */
function findAllElements(root: parse5.Element, tagName: string): parse5.Element[] {
  const results: parse5.Element[] = [];
  const target = tagName.toLowerCase();

  function walk(node: parse5.Node) {
    if (isElementNode(node)) {
      if (T.getTagName(node).toLowerCase() === target) {
        results.push(node);
      }
      for (const child of T.getChildNodes(node)) {
        walk(child);
      }
    }
  }

  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Inline tests
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const passed: string[] = [];
  const failed: string[] = [];

  function assert(condition: boolean, label: string) {
    if (condition) passed.push(label);
    else failed.push(label);
  }

  // --- Test 1: Parse + serialize roundtrip preserves content -----------------
  {
    const original = `<html><head></head><body><main>
      <h1 id="title">Hello</h1>
      <!-- markdown-blocks:p-0 -->
      <p>World</p>
    </main></body></html>`;

    const doc = parseHtml(original);
    const result = serialize(doc);

    // The roundtrip should contain all key content elements
    assert(result.includes("<h1 id=\"title\">Hello</h1>"), "roundtrip preserves h1 with attrs");
    assert(result.includes("<!-- markdown-blocks:p-0 -->"), "roundtrip preserves comments");
    assert(result.includes("<p>World</p>"), "roundtrip preserves p element");
  }

  // --- Test 2: Comment anchor detection -------------------------------------
  {
    const html = `<html><head></head><body>
<main>
  <h1>Template heading</h1>
  <!-- markdown-blocks:h1-0 -->
  <h1 id="page">Page Title</h1>
  <!-- markdown-blocks:p-0 -->
  <p>Hello world</p>
  <!-- not-a-mb-comment -->
  <span>irrelevant</span>
  <!-- markdown-blocks:ul-0 -->
  <ul><li>Item</li></ul>
</main>
<footer><!-- markdown-blocks:p-1 --></footer>
</body></html>`;

    const doc = parseHtml(html);
    const main = findElementBySelector(doc, "main");
    assert(main !== null, "findElementBySelector finds <main>");

    if (main) {
      const anchors = findCommentAnchors(main);
      assert(anchors.length === 3, `findCommentAnchors found ${anchors.length} anchors (expected 3)`);
      assert(anchors[0].blockId === "h1-0", `first anchor blockId is h1-0`);
      assert(anchors[0].nextElement !== null && T.getTagName(anchors[0].nextElement).toLowerCase() === "h1", "first anchor nextElement is H1");
      assert(anchors[1].blockId === "p-0", `second anchor blockId is p-0`);
      assert(anchors[1].nextElement !== null && T.getTagName(anchors[1].nextElement).toLowerCase() === "p", "second anchor nextElement is P");
      assert(anchors[2].blockId === "ul-0", `third anchor blockId is ul-0`);
    }

    // Verify non-matching comment is skipped
    if (main) {
      const anchors = findCommentAnchors(main);
      const ids = anchors.map(a => a.blockId);
      assert(!ids.includes("not-a-mb-comment"), "non-matching comment excluded");
    }
  }

  // --- Test 3: Element replacement ------------------------------------------
  {
    const html = `<html><head></head><body><main>
  <h1 id="page">Original</h1>
  <p class="desc">Description</p>
</main></body></html>`;

    const doc = parseHtml(html);
    const main = findElementBySelector(doc, "main")!;
    const h1s = findAllElements(main, "h1");

    assert(h1s.length === 1, `findAllElements finds 1 h1`);

    // Create replacement element via tree adapter
    const newP = T.createElement("p", "http://www.w3.org/1999/xhtml", [
      { name: "class", value: "replaced" },
    ]);
    T.appendChild(newP, T.createTextNode("Replaced content", "http://www.w3.org/1999/xhtml"));

    const childCountBefore = getDirectChildren(main).length;
    const ok = replaceParent(h1s[0], newP);
    assert(ok === true, "replaceParent returns true");
    // Element count stays the same (h1 replaced by p), whitespace text nodes unaffected
    assert(getDirectChildren(main).length === childCountBefore, `direct element children count preserved after replacement`);

    const result = serialize(doc);
    assert(result.includes('<p class="replaced">Replaced content</p>'), "replacement content in serialized HTML");
    assert(!result.includes("Original"), "original h1 removed from serialized HTML");
    assert(result.includes("Description"), "other children preserved after replacement");
  }

  // --- Test 4: getDirectChildren filters non-element nodes -------------------
  {
    const html = `<html><head></head><body><main>
  <h1>Title</h1>
  <!-- comment -->
  <p>Para</p>
  some text node
  <span>nested</span>
</main></body></html>`;

    const doc = parseHtml(html);
    const main = findElementBySelector(doc, "main")!;
    const directChildren = getDirectChildren(main);

    assert(directChildren.length === 3, `getDirectChildren returns 3 elements (got ${directChildren.length})`);
    assert(T.getTagName(directChildren[0]).toLowerCase() === "h1", "first direct child is H1");
    assert(T.getTagName(directChildren[1]).toLowerCase() === "p", "second direct child is P");
    assert(T.getTagName(directChildren[2]).toLowerCase() === "span", "third direct child is SPAN");
  }

  // --- Test 5: isBlockTag ---------------------------------------------------
  {
    assert(isBlockTag("h1") === true, "h1 is block tag");
    assert(isBlockTag("H3") === true, "H3 (uppercase) is block tag");
    assert(isBlockTag("p") === true, "p is block tag");
    assert(isBlockTag("ul") === true, "ul is block tag");
    assert(isBlockTag("blockquote") === true, "blockquote is block tag");
    assert(isBlockTag("div") === false, "div is NOT block tag");
    assert(isBlockTag("span") === false, "span is NOT block tag");
  }

  // --- Test 6: replaceParent returns false for root-level node ---------------
  {
    const html = `<html><head></head><body></body></html>`;
    const doc = parseHtml(html);

    // An orphaned element (created but never attached) should have no parent
    const orphaned = T.createElement("div", "http://www.w3.org/1999/xhtml", []);
    assert(T.getParentNode(orphaned) === null, "orphaned node has no parent");

    const replacement = T.createElement("span", "http://www.w3.org/1999/xhtml", []);
    const ok = replaceParent(orphaned, replacement);
    assert(ok === false, "replaceParent returns false for orphaned node");
  }

  // --- Test 7: Comment in <footer> not found when searching <main> -----------
  {
    const html = `<html><head></head><body>
<main><!-- markdown-blocks:h1-0 --><h1>Main</h1></main>
<footer><!-- markdown-blocks:p-0 --><p>Footer para</p></footer>
</body></html>`;

    const doc = parseHtml(html);
    const main = findElementBySelector(doc, "main")!;
    const anchors = findCommentAnchors(main);
    assert(anchors.length === 1, `main only has 1 anchor (got ${anchors.length})`);
    assert(anchors[0].blockId === "h1-0", "anchor is h1-0");
  }

  // --- Report ----------------------------------------------------------------
  console.log(`\n${passed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log("FAILURES:");
    for (const f of failed) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log("All inline tests passed!");
  }
}
