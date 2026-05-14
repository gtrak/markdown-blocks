# 03 — Extract MarkdownService from save.ts

## Objective

Split the 400-line monolith in `save.ts` into a thin HTTP controller (`save.ts`) and a `MarkdownService` class that encapsulates file I/O security, AST mutations, and atomic writes. This makes the save logic independently unit-testable.

## Files

| File | Action | Reason |
|------|--------|--------|
| `src/markdown-service.ts` | **Create** | New service class for all markdown mutations |
| `src/save.ts` | Edit | Strip to HTTP controller only |
| `test/save.test.ts` | Verify only | Should pass unchanged |

## Steps

### 3.1 Create `src/markdown-service.ts`

A new class with the following interface:

```ts
export class MarkdownService {
  constructor(private config: Config, private indexer: Indexer);

  resolveFile(body: SaveBody): { filepath: string; errorResponse?: Response };
  readRawBlock(filepath: string, blockId: string): { raw: string; block: Block } | { error: Response };
  edit(filepath: string, blockId: BlockId, text: string): { result: string; success: boolean };
  delete(filepath: string, blockId: BlockId): { result: string; success: boolean };
  insert(filepath: string, afterBlockId: BlockId, tag: string, text: string): { result: string; success: boolean };
  move(filepath: string, blockId: BlockId, options: MoveOptions): { result: string; success: boolean };
  writeAtomically(filepath: string, content: string): { success: boolean; error?: Response };
}
```

Implementation notes:
- **Move** the `isInsideDir` helper into this file (or keep it module-private in `save.ts` if the service imports it).
- **Move** the filepath-resolution logic shared by `handleSave` and `handleSource` into `resolveFile()`.
- **Move** the atomic write pattern (`writeFileSync` to `.tmp`, then `renameSync`, with cleanup) into `writeAtomically()`.
- **Move** the `deannotate → [mutate] → annotate` pipeline into each mutation method.
- Keep `renderBlock` calls in the HTTP controller (`save.ts`) since that's a presentation concern.

### 3.2 Edit `src/save.ts`

1. Import `MarkdownService`.
2. At the top of `handleSave`, instantiate the service:
   ```ts
   const service = new MarkdownService(config, indexer);
   ```
3. Replace the entire mutation block with service calls:
   ```ts
   const resolved = service.resolveFile(body);
   if (resolved.errorResponse) return resolved.errorResponse;

   const { filepath } = resolved;
   let mutationResult: { result: string; success: boolean };

   switch (action) {
     case "edit":
       mutationResult = service.edit(filepath, parsedId, newText);
       break;
     case "delete":
       mutationResult = service.delete(filepath, parsedId);
       break;
     // ... etc
   }
   ```
4. The HTMX response formatting (rendering block HTML, building shells) stays in `save.ts`.
5. `handleSource` similarly becomes:
   ```ts
   const service = new MarkdownService(config, indexer);
   const resolved = service.resolveFile({ path: pagePath });
   // ... use service.readRawBlock() to extract markdown
   ```

## Verification

```bash
bun test test/save.test.ts
```

All tests should pass without modification. The `MarkdownService` itself can be unit-tested in the future, but no new tests are required to satisfy this plan.
