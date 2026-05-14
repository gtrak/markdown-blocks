# 07 — Lazy Asynchronous Client Compilation

## Objective

Remove the synchronous `Bun.spawnSync` call that blocks the event loop on module import. Compile the client script asynchronously on the first request to `/mb-client.js`, caching the result.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/server.ts` | Edit | Replace sync `compileClientScript` with async `getClientScript` |
| `src/server.ts` | Edit | Update `/mb-client.js` handler to `await` the compilation |
| `test/integration.test.ts` | Verify only | Should still pass; first request will trigger compilation |

## Steps

### 7.1 Rewrite client compilation in `src/server.ts`

Remove the top-level synchronous compilation block entirely.

Replace with:

```ts
let clientCompilationPromise: Promise<Uint8Array> | null = null;

async function getClientScript(): Promise<Uint8Array> {
  if (clientCompilationPromise) return clientCompilationPromise;

  clientCompilationPromise = (async () => {
    const pkgRoot = resolve(import.meta.dirname, "..");
    const proc = Bun.spawn({
      cmd: [process.execPath, "build", "--target=browser", "--format=iife", "--no-bundle", "./src/client.ts"],
      cwd: pkgRoot,
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stderr!));
      throw new Error(`Client compile failed: ${err}`);
    }

    const stdout = await Bun.readableStreamToArrayBuffer(proc.stdout!);
    return new Uint8Array(stdout);
  })();

  return clientCompilationPromise;
}
```

### 7.2 Update `/mb-client.js` handler

```ts
if (url.pathname === "/mb-client.js") {
  try {
    const script = await getClientScript();
    return new Response(script, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(msg, { status: 500 });
  }
}
```

### 7.3 Remove old state variables

Remove the old `compiledClient`, `compiledClientError`, and `compileClientScript` definitions.

## Verification

```bash
bun test test/integration.test.ts
```

The first request to `/mb-client.js` during the test will trigger compilation. Server startup should be instantaneous.
