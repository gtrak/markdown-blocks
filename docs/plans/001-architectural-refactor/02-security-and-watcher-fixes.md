# 02 — Security & Watcher Fixes

## Objective

Close two small but critical gaps: path-traversal via symlinks in `save.ts`, and file-watcher leaks/re-registrations in `indexer.ts`.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/save.ts` | Edit | Add `realpathSync` to `isInsideDir` |
| `src/indexer.ts` | Edit | Close watcher leaks and ensure `stopWatch` clears the debounce timer |

## Steps

### 2.1 Fix `isInsideDir` in `src/save.ts`

Replace the function body with symlink resolution:

```ts
function isInsideDir(filepath: string, dir: string): boolean {
  const absFile = path.resolve(fs.realpathSync(filepath));
  const absDir = path.resolve(fs.realpathSync(dir));
  return absFile.startsWith(absDir + path.sep) || absFile === absDir;
}
```

### 2.2 Fix watcher leaks in `src/indexer.ts`

In `watch()`:
- Before creating new watchers, call `this.stopWatch()` to close any existing ones.

In `stopWatch()`:
- Clear the debounce timer:
  ```ts
  stopWatch(): void {
    if (this.watchHandle) {
      clearInterval(this.watchHandle);
      this.watchHandle = null;
    }
    for (const watcher of this.fsWatchers) {
      watcher.close();
    }
    this.fsWatchers = [];
    this.onChangeCallback = null;
    // NEW: clear any pending debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
  ```
- Move `debounceTimer` from a local variable in `watch()` to a class field (`private debounceTimer: ReturnType<typeof setTimeout> | null = null`).

## Verification

```bash
bun test test/save.test.ts
```

- Path-traversal test should still return 403.
- No new failures in watcher behavior (confirmed indirectly by indexer tests).
