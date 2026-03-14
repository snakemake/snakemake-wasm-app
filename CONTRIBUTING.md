# Contributing

Thanks for contributing to Snakemake WASM App.

## Scope

This repository contains:

- SvelteKit frontend app (UI, web worker orchestration)
- Python executor plugin in `snakemake-executor-plugin-wasm/`
- Runtime asset sync scripts for Pyodide, wheels, and v86

## Prerequisites

- Node.js 20+
- npm 10+
- `pixi` (recommended for Python plugin development)
- Python 3.11+ (fallback if not using pixi)

## Setup

```sh
npm install
npm run sync:assets
```

## Developer workflows

### Frontend development

```sh
npm run dev
```

### Type checking

```sh
npm run check
```

### Production build

```sh
npm run build:app
```

## Executor plugin workflows

The plugin source lives in `snakemake-executor-plugin-wasm/`.

### Run plugin tests (pixi)

```sh
cd snakemake-executor-plugin-wasm
pixi run test
```

### Build plugin wheel

From repository root:

```sh
npm run build:plugin-wheel
```

### Sync plugin wheel into app runtime

From repository root:

```sh
npm run sync:plugin-wheel
```

### Full runtime asset sync

From repository root:

```sh
npm run sync:assets
```

## Coding guidelines

- Keep changes focused and minimal.
- Preserve existing behavior unless the change explicitly targets behavior updates.
- Prefer root-cause fixes over one-off patches.
- Avoid committing generated artifacts unless required by project workflow.

## Pull request checklist

Before opening a PR:

1. Run `npm run check`.
2. If plugin code changed, run plugin tests (`pixi run test`).
3. If plugin packaging/runtime changed, run `npm run sync:plugin-wheel`.
4. Verify the app starts (`npm run dev`) and a sample workflow runs.
5. Update docs (`README.md`, this file) when behavior or commands change.

## Commit guidance

- Use clear commit messages describing intent and impact.
- Keep commits logically scoped (UI, worker, plugin, docs, etc.).
- Include migration notes in PR descriptions when changing runtime behavior.

## Reporting issues

When filing bugs, include:

- browser/version
- worker count used
- relevant log snippet
- minimal reproducible Snakefile/config
- whether runtime files were uploaded or loaded via URL params
