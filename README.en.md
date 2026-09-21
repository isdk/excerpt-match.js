# excerpt-match workspace

English | [中文](./README.md)

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
run** with a single summary line (`Test Files 25 passed / Tests 349 passed`).
You can also run one package: `pnpm --filter @isdk/zh-negation test`.

**No path aliases at all** — pnpm workspaces already symlink `@isdk/*` to
`packages/*`, and each package's `main`/`exports` point at **`src/index.ts` in
dev** while `publishConfig` switches to `dist` on publish. So tests never
depend on build output, and `tsconfig.json` has no `paths`.

## Release

Versioning and CHANGELOGs are managed by
[commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version)
(`-s` GPG-signs the release commit and tag):

```bash
# Release everything: all packages clean → build → release in dependency (topological) order
pnpm release

# Release a single package: bump version / generate CHANGELOG / tag only
pnpm --filter @isdk/md-flatten release

# List all release tags of one package
git tag -l "@isdk/md-flatten/*"
```

- **Tag prefix is the package name**: package tags look like `@isdk/md-flatten/v1.0.1` so they never collide; the root is a private workspace-management package and keeps no version record of its own (no bump, no CHANGELOG, no tag)
- **Serial commits**: package releases run with `--workspace-concurrency=1` so concurrent `git commit` calls don't race on `.git/index.lock`
- **Idempotent**: packages without new commits are skipped entirely (no bump, no tag), so re-running the full release is safe

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
