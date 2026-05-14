# 05 — Normalize Line Endings in AST Pipeline

## Objective

Prevent CRLF (`\r\n`) corruption on Windows by normalizing line endings at the entry points of all AST operations. The entire markdown pipeline should assume LF internally.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/ast.ts` | Edit | Add `normalizeEol` helper; call at top of `parseBlocks`, `replaceBlock`, `deleteBlock`, `insertBlock`, `moveBlock` |
| `test/save.test.ts` | Verify only | All existing tests use LF; this prevents regressions on CRLF inputs |

## Steps

### 5.1 Add helper to `src/ast.ts`

```ts
function normalizeEol(source: string): string {
  return source.replace(/\r\n/g, "\n");
}
```

### 5.2 Call it in public functions

At the very top of each function:

```ts
export function parseBlocks(source: string): Block[] {
  source = normalizeEol(source);
  // ... rest unchanged
}

export function replaceBlock(source: string, ...): ... {
  source = normalizeEol(source);
  // ... rest unchanged
}

// Same for deleteBlock, insertBlock, moveBlock, moveBlockByDirection
```

**Important:** The output of these functions will now always use LF line endings. This is correct for markdown source files and is what the test suite already expects.

### 5.3 Remove `normalizeEol` concern from `annotate.ts`

`annotate.ts` relies on `parseBlocks`, which now normalizes internally. No change needed in `annotate.ts` except confirming that `deannotate` does not need to handle `\r` (it only removes comment markers).

## Verification

```bash
bun test test/save.test.ts
```

All tests pass. Optionally, add a quick manual test with a CRLF fixture:

```ts
const crlf = "# Heading\r\n\r\nParagraph.\r\n";
const blocks = parseBlocks(crlf);
expect(blocks[0].position.start.line).toBe(1);
```
