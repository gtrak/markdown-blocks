# 08 — Pluggable Presets, TOML Parser & Local HTMX

## Objective

Make the preset system extensible at runtime, replace the hand-rolled TOML frontmatter parser with a real dependency, and allow serving HTMX locally instead of hardcoding the CDN URL.

## Files

| File | Action | Reason |
|------|--------|--------|
| `package.json` | Edit | Add `smol-toml` (or `@ltd/j-toml`) and `markdown-it` (if not already present) |
| `src/config.ts` | Edit | Add `registerPreset`; replace hand-rolled TOML with real parser |
| `src/ast.ts` | Edit | Remove hand-rolled TOML loop; delegate to TOML parser via `config.ts` |
| `src/types.ts` | Edit | Add `htmxSource?: "cdn" \| "bundled"` to `Config` |
| `src/inject.ts` | Edit | Support `htmxSource` config; inject local HTMX script when configured |
| `src/server.ts` | Edit | Wire `htmxSource` into injection pipeline |

## Steps

### 8.1 Add TOML dependency

```bash
bun add smol-toml
```

(Alternative: `@ltd/j-toml` if `smol-toml` has compatibility issues with Bun.)

### 8.2 Edit `src/config.ts`

1. Add module-level registry:
   ```ts
   const customPresets = new Map<string, Preset>();
   ```

2. Export:
   ```ts
   export function registerPreset(name: string, preset: Preset): void {
     customPresets.set(name, preset);
   }
   ```

3. In `getPreset`, check custom presets first:
   ```ts
   export function getPreset(name: string): Preset {
     if (customPresets.has(name)) return customPresets.get(name)!;
     // ... existing switch
   }
   ```

4. Replace the hand-rolled TOML parsing in `parseFrontmatterFromContent` (or `extractFrontmatter` in `ast.ts`) with:
   ```ts
   import { parse as parseToml } from "smol-toml";
   
   if (fmNode.type === "toml") {
     parsed = parseToml(nodeValue) || {};
   }
   ```

### 8.3 Edit `src/ast.ts`

In `extractFrontmatter`, replace the hand-rolled TOML loop with a call to the real parser. The `yaml` branch stays as-is.

If `smol-toml` is used via `config.ts`, ensure `ast.ts` imports it directly or receives a parser injection.

**Decision:** Import `smol-toml` directly in `ast.ts` to keep `extractFrontmatter` self-contained and avoid a config dependency.

```ts
import { parse as parseToml } from "smol-toml";

// In extractFrontmatter:
if (fmNode.type === "toml") {
  parsed = parseToml(nodeValue) || {};
}
```

### 8.4 Edit `src/types.ts`

Add to `Config`:

```ts
export interface Config {
  // ... existing fields ...
  /** How HTMX should be served: "cdn" (default) or "bundled" (served locally from node_modules) */
  htmxSource?: "cdn" | "bundled";
}
```

### 8.5 Edit `src/inject.ts`

1. Make `HTMX_CLIENT_SCRIPT` accept a source parameter:
   ```ts
   const HTMX_CLIENT_SCRIPT_CDN = `<script src="https://unpkg.com/htmx.org@2.0.4" crossorigin="anonymous"></script>`;
   const HTMX_CLIENT_SCRIPT_BUNDLED = `<script src="/htmx.min.js"></script>`;
   ```

2. Update `injectHtmxClient` to accept `htmxSource?: "cdn" | "bundled"`:
   ```ts
   export function injectHtmxClient(html: string, htmxSource: "cdn" | "bundled" = "cdn"): string {
     const script = htmxSource === "bundled" ? HTMX_CLIENT_SCRIPT_BUNDLED : HTMX_CLIENT_SCRIPT_CDN;
     // ... inject using parse5, same as Phase 4
   }
   ```

3. Add HTMX static file serving in `src/server.ts`:
   ```ts
   if (url.pathname === "/htmx.min.js") {
     const htmxPath = require.resolve("htmx.org/dist/htmx.min.js");
     const content = fs.readFileSync(htmxPath);
     return new Response(content, { headers: { "Content-Type": "text/javascript" } });
   }
   ```
   *(Note: If `htmx.org` is not in dependencies, add it to `package.json` or copy a vendored copy into `src/`.)*

   **Simpler alternative:** Vendoring. Copy `htmx.min.js` into `src/vendor/htmx.min.js` and serve it directly. This avoids runtime `require.resolve` and another dependency.

### 8.6 Edit `src/server.ts`

1. Pass `config.htmxSource` into `injectHtmxClient(html, config.htmxSource)`.
2. Add the `/htmx.min.js` static route (if using vendored copy) **before** the proxy fallback.

## Verification

```bash
bun test test/save.test.ts
bun test test/integration.test.ts
# If adding a preset test:
bun test test/preset.test.ts
```

- TOML frontmatter roundtrip should work with nested objects and arrays.
- Custom preset registration should resolve URLs correctly.
- HTMX bundled mode should serve the local script (verified manually or via a new integration test if desired).
