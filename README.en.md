# excerpt-match workspace

Locate an excerpt **inside a markdown document** and return exact source
coordinates (`index` / `length`).

This repository is the **pnpm workspace root** and is **not published**;
the real packages live under `packages/`.

## Quick start

```bash
pnpm install

# Per-package tests (root only recurses, same as build)
pnpm test
pnpm --filter @isdk/zh-negation test

pnpm run typecheck
pnpm run build
```

**Test layout**: `vitest.workspace.ts` aggregates all 9 packages into **one
run** with a single summary line (`Test Files 19 passed / Tests 253 passed`).
You can also run one package: `pnpm --filter @isdk/zh-negation test`.

**No path aliases at all** — pnpm workspaces already symlink `@isdk/*` to
`packages/*`, and each package's `main`/`exports` point at **`src/index.ts` in
dev** while `publishConfig` switches to `dist` on publish. So tests never
depend on build output, and `tsconfig.json` has no `paths`.

## Packages

| package | role |
|---|---|
| [`@isdk/excerpt-match`](./packages/excerpt-match) | **root package**: tiered locating and orchestration (T0–T4) |
| [`@isdk/normalize-text`](./packages/normalize-text) | normalize while keeping source coordinates |
| [`@isdk/md-flatten`](./packages/md-flatten) | md source ↔ rendered text coordinate mapping |
| [`@isdk/approx-text-match`](./packages/approx-text-match) | approximate substring location (contiguous span + score) |
| [`@isdk/semantic-locate`](./packages/semantic-locate) | two-stage semantic locating: retrieve → align |
| [`@isdk/whitespace-semantics`](./packages/whitespace-semantics) | script-aware whitespace (Hangul/Thai spaces matter) |
| [`@isdk/identifier-variants`](./packages/identifier-variants) | `TensorFlow` ≡ `tensor_flow` |
| [`@isdk/zh-negation`](./packages/zh-negation) | Chinese negation detection (word-boundary aware) |
| [`@isdk/zh-particles`](./packages/zh-particles) | 的/地/得: particle vs content word |

Each package has its own `README.md` / `README.en.md`.

## Docs

- Package split and responsibilities: [PACKAGES.md](./PACKAGES.md) / [PACKAGES.en.md](./PACKAGES.en.md)
- Architecture and coordinate systems: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Root package usage: [packages/excerpt-match/README.md](./packages/excerpt-match/README.md)

## Conventions

- **Tests live next to the file under test**: `src/xxx.ts` ↔ `src/xxx.test.ts`
- `index.ts` is a pure barrel
- Packages reference each other via `@isdk/*` (aliases in dev, no import
  changes when publishing separately)
- TSDoc comments focus on **why**
