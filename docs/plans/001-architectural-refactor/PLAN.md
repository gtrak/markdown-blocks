# Plan 001 — Architectural Refactor: Robustness, Simplification & Extensibility

## Why

The markdown-blocks project has accumulated technical debt that makes it harder to maintain, test, and extend:
- **Duplicate signal handlers** across three files create shutdown races and prevent graceful cleanup.
- **Dual config types** (`SaveServerConfig` vs `Config`) lead to ambiguity and manual coercion.
- **Monolithic save handler** (`save.ts`, ~400 lines) mixes HTTP, AST mutations, file I/O, and presentation.
- **Inconsistent HTML injection** — shell wrapping uses parse5 correctly, but client asset injection falls back to fragile string surgery.
- **Path-traversal vulnerability** via symlinks.
- **Synchronous client build** on module import blocks the event loop.
- **Inflexible preset system** — adding a new SSG requires editing `config.ts` source.

## What

A multi-phase refactor that simplifies the architecture while **strictly preserving the existing test suite**:
1. Centralize cleanup and config into one CLI entry point.
2. Close security gaps and resource leaks.
3. Extract a `MarkdownService` from `save.ts` to separate HTTP from business logic.
4. Unify all HTML injection under parse5 DOM manipulation.
5. Normalize line endings in the AST pipeline.
6. Remove global namespace pollution from the client module.
7. Make client compilation lazy and asynchronous.
8. Introduce pluggable presets and a real TOML parser, with local HTMX bundling support.

## Success Criteria

- `bun test` passes fully (all existing tests, with minimal updates only for breaking interface changes or removed globals).
- `bin/server.ts` is the **only** CLI entry point.
- `createSaveHandler` returns `{ handler, cleanup }`.
- `save.ts` only handles HTTP concerns; AST/file mutations live in `MarkdownService`.
- All HTML injection uses parse5 (no more `indexOf`/`slice` string manipulation).
- Windows CRLF files are handled correctly.
- Client-side global `__scriptExecuted` is removed.
- Client script compiles asynchronously on first request.
- Users can register custom presets at runtime.
- Real TOML frontmatter parsing is supported.

## Task Order

Dependencies are sequential within a phase but many phases are independent after Phase 1.

| Order | File | Phase | Depends On |
|-------|------|-------|------------|
| 1 | `01-deduplicate-cli-entry-points.md` | Config & Lifecycle | — |
| 2 | `02-security-and-watcher-fixes.md` | Robustness fixes | Phase 1 |
| 3 | `03-extract-markdown-service.md` | Service refactor | Phase 1 |
| 4 | `04-unify-html-injection.md` | HTML architecture | Phase 1 |
| 5 | `05-normalize-line-endings.md` | AST fixes | Phase 1 |
| 6 | `06-clean-client-globals.md` | Client cleanup | — |
| 7 | `07-lazy-async-build.md` | Startup perf | Phase 1 |
| 8 | `08-pluggable-presets-and-toml.md` | Extensibility | Phase 1 |
