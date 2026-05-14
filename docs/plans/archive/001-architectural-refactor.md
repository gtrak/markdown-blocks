# Plan 001 — Architectural Refactor (Completed)

A multi-phase refactor that improved code robustness, simplified the architecture, and made the system extensible at runtime. All changes strictly preserved the existing test suite (68 tests, 0 failures).

## What and Why

The project accumulated technical debt: duplicate signal handlers across three files caused shutdown races, a hand-rolled TOML parser couldn't handle nested structures, synchronous client compilation blocked startup, and string-based HTML injection was fragile.

## Scope

- **src/server.ts** — unified handler factory returning `{ handler, cleanup }`; lazy async client compilation
- **src/save.ts** → **src/markdown-service.ts** — extracted business logic from 400-line monolith
- **src/inject.ts** — all HTML injection uses parse5 DOM operations consistently
- **src/ast.ts** — real TOML parsing via `smol-toml`, CRLF normalization at all entry points
- **src/config.ts** — runtime preset registration via `registerPreset`
- **src/indexer.ts** — fixed watcher leak (debounce timer promoted to class field)
- **src/types.ts** — extended Config with `htmxSource` option

## Tasks Completed

1. Deduplicate CLI entry points & centralize configuration (delete save-server.ts, remove SaveServerConfig)
2. Security & watcher fixes (realpathSync in isInsideDir, debounceTimer leak fix)
3. Extract MarkdownService from save.ts (new class for file I/O, AST mutations, atomic writes)
4. Unify HTML injection under parse5 (rewrote injectHtmxClient and injectUneditableBanner)
5. Normalize line endings in AST pipeline (normalizeEol at all public function entry points)
6. Clean client-side globals (removed window.__scriptExecuted)
7. Lazy async client compilation (replaced Bun.spawnSync with Promise-cached lazy compile)
8. Pluggable presets, real TOML parser & local HTMX (smol-toml dependency, registerPreset, htmxSource config)
