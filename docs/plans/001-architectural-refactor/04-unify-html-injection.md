# 04 — Unify HTML Injection Under parse5

## Objective

`injectHtmxShells` already uses parse5 correctly, but `injectHtmxClient` and `injectUneditableBanner` fall back to fragile string surgery (`indexOf`, `match`, `slice`). Rewrite all HTML injection to use the `inject_dom.ts` parse5 utilities consistently.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/inject.ts` | Edit | Rewrite `injectHtmxClient` and `injectUneditableBanner` to use parse5 |
| `src/inject_dom.ts` | Edit | Add helper: `insertBefore` (for inserting nodes into `<head>` / `<body>`) |
| `src/server.ts` | Edit | Add `buildProxyResponse()` helper to centralize header cloning |
| `test/save.test.ts` | Verify only | Injection tests should still pass |

## Steps

### 4.1 Add `insertBefore` to `src/inject_dom.ts`

```ts
export function insertBefore(parent: parse5.ParentNode, newNode: parse5.Node, referenceNode: parse5.Node): void {
  T.insertBefore(parent, newNode, referenceNode);
}
```

### 4.2 Rewrite `injectHtmxClient` in `src/inject.ts`

```ts
export function injectHtmxClient(html: string): string {
  const doc = parse5Parse(html);
  const htmlEl = findElementBySelector(doc, "html");
  if (htmlEl) {
    const attrs = P5T.getAttrList(htmlEl);
    if (attrs.some(a => a.name === "data-mb-client")) return html; // idempotent
  }

  const head = findElementBySelector(doc, "head") || findElementBySelector(doc, "html");
  const body = findElementBySelector(doc, "body") || findElementBySelector(doc, "html");

  if (head) {
    // Parse script + style into fragments and append to head
    const headFragment = parse5.parseFragment(HTMX_CLIENT_SCRIPT + HTMX_CLIENT_CSS);
    for (const child of P5T.getChildNodes(headFragment)) {
      P5T.appendChild(head, child);
    }
  }

  if (body) {
    const bodyFragment = parse5.parseFragment(HTMX_CLIENT_BODY);
    for (const child of P5T.getChildNodes(bodyFragment)) {
      P5T.appendChild(body, child);
    }
  }

  if (htmlEl) {
    P5T.setAttrList(htmlEl, [...P5T.getAttrList(htmlEl), { name: "data-mb-client", value: "1" }]);
  }

  return parse5Serialize(doc);
}
```

### 4.3 Rewrite `injectUneditableBanner` in `src/inject.ts`

```ts
export function injectUneditableBanner(html: string): string {
  const doc = parse5Parse(html);
  const htmlEl = findElementBySelector(doc, "html");
  if (htmlEl) {
    const attrs = P5T.getAttrList(htmlEl);
    if (attrs.some(a => a.name === "data-uneditable-banner")) return html;
  }

  const body = findElementBySelector(doc, "body") || findElementBySelector(doc, "html");
  if (!body) return html + BANNER_SCRIPT; // absolute fallback

  // Parse banner script into a fragment and prepend to body
  const fragment = parse5.parseFragment(BANNER_SCRIPT);
  const firstChild = P5T.getChildNodes(body)[0];
  for (const child of P5T.getChildNodes(fragment)) {
    if (firstChild) {
      P5T.insertBefore(body, child, firstChild);
    } else {
      P5T.appendChild(body, child);
    }
  }

  if (htmlEl) {
    P5T.setAttrList(htmlEl, [...P5T.getAttrList(htmlEl), { name: "data-uneditable-banner", value: "1" }]);
  }

  return parse5Serialize(doc);
}
```

### 4.4 Add `buildProxyResponse` in `src/server.ts`

Replace the duplicated header manipulation with:

```ts
function buildProxyResponse(modifiedHtml: string, rawRes: Response): Response {
  const headers = new Headers();
  for (const [k, v] of rawRes.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  headers.delete("content-length");
  return new Response(modifiedHtml, { status: rawRes.status, headers });
}
```

Use it in both the "source exists" and "no source" branches.

## Verification

```bash
bun test test/save.test.ts
```

- `injectUneditableBanner` idempotency test must pass.
- `injectHtmxShells` tests must pass.
