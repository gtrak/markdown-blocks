# 06 — Clean Client-Side Globals

## Objective

Remove the unused `window.__scriptExecuted` global from the client module and update the integration test that asserts it. Replace with a check for the actual DOM side-effect (`#save-indicator`).

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/client.ts` | Edit | Remove `window.__scriptExecuted = true` |
| `test/client.test.ts` | Edit | Remove `__scriptExecuted` assertion |
| `test/integration.test.ts` | Edit | Replace `__scriptExecuted` check with `#save-indicator` existence check |

## Steps

### 6.1 Edit `src/client.ts`

Remove this line:

```ts
window.__scriptExecuted = true;
```

### 6.2 Edit `test/client.test.ts`

Remove the entire test block:

```ts
// REMOVED:
test("sets window.__scriptExecuted to true", async () => { ... });
```

### 6.3 Edit `test/integration.test.ts`

In the "page loads with injected mb-block elements" test:

```ts
// FROM:
const scriptExecuted = await page.evaluate(() =>
  (window as any).__scriptExecuted
);
expect(scriptExecuted).toBe(true);

// TO:
const indicatorExists = await page.evaluate(() =>
  !!document.getElementById("save-indicator")
);
expect(indicatorExists).toBe(true);
```

## Verification

```bash
bun test test/client.test.ts
bun test test/integration.test.ts
```

Both should pass.
