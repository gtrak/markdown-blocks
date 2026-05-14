# 01 — Deduplicate CLI Entry Points & Centralize Configuration

## Objective

Eliminate duplicate signal handlers, remove the dual-config ambiguity (`SaveServerConfig` vs `Config`), and make the server library not hijack global process events. `bin/server.ts` becomes the sole CLI entry point; `src/save-server.ts` is deleted.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/save-server.ts` | **Delete** | Fully superseded by `bin/server.ts` |
| `src/types.ts` | Edit | Remove `SaveServerConfig` interface |
| `src/server.ts` | Edit | Accept only `Config`; remove `process.on` wiring; return `{ handler, cleanup }` |
| `bin/server.ts` | Edit | Build full `Config` from CLI args; register signals; call `cleanup` on shutdown |
| `test/integration.test.ts` | Edit | Destructure `{ handler }` from `createSaveHandler` |

## Steps

### 1.1 Delete `src/save-server.ts`

```bash
rm src/save-server.ts
```

### 1.2 Edit `src/types.ts`

Remove the `SaveServerConfig` interface:

```ts
// REMOVED entirely:
// export interface SaveServerConfig { ... }
```

Keep `Config` exactly as-is.

### 1.3 Edit `src/server.ts`

1. Remove the `SaveServerConfig` import and interface definition.
2. Change `createSaveHandler` signature:
   ```ts
   export function createSaveHandler(
     cfg: Config,
   ): { handler: (req: Request) => Promise<Response>; cleanup: () => void } {
   ```
3. Move all `process.on("SIGTERM", ...)`, `SIGINT`, and `"exit"` registrations from `src/server.ts` into the returned `cleanup` closure. `cleanup` should:
   - Call `deannotateAll(cfg.contentDir)`.
   - Call `indexer.stopWatch()` (ensure `stopWatch` exists).
4. Remove the backward-compat config normalization block:
   ```ts
   // REMOVED:
   // const cfg: Config = Object.assign({}, raw as Partial<Config>, { ... });
   ```
5. Return both handler and cleanup:
   ```ts
   return { handler, cleanup };
   ```
6. Update the `/mb-client.js` handler and `/save` handler to refer to the internal `handler` function.

### 1.4 Edit `bin/server.ts`

1. After parsing CLI args, construct a **full** `Config` object:
   ```ts
   const config: Config = {
     contentDir: cfg.contentDir,
     preset: cfg.preset,
     trailingSlash: true, // or default from preset
     backendProxyUrl: cfg.backendProxyUrl,
     pathMap: cfg.pathMap,
   };
   ```
2. Destructure from `createSaveHandler`:
   ```ts
   const { handler, cleanup } = createSaveHandler(config);
   ```
3. Register signal handlers **here** (the CLI owns process lifecycle):
   ```ts
   process.on("SIGTERM", () => { cleanup(); process.exit(0); });
   process.on("SIGINT", () => { cleanup(); process.exit(0); });
   ```

### 1.5 Edit `test/integration.test.ts`

Update the `createSaveHandler` call:

```ts
// FROM:
const handler = createSaveHandler(cfg);

// TO:
const { handler } = createSaveHandler(cfg);
```

## Verification

```bash
bun test test/integration.test.ts
cd bin && bun run server.ts --help
```

- `server.ts --help` should work (exit 0).
- All integration tests should pass.
