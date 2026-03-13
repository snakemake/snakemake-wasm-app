# Snakemake WASM SvelteKit App

This app is the SvelteKit + TypeScript migration of the browser-based Snakemake WASM UI.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```sh
cd snakemake-wasm-app
npm install
```

## Sync runtime assets

The app depends on local runtime assets from the repository root (`wheels`, `v86`, `thirdparty/v86`, `Snakefile`).
It also rebuilds and syncs the local plugin wheel from `snakemake-executor-plugin-wasm/dist` into `static/wheels`
(`npm run build:plugin-wheel`, then copy). The build script prefers
`snakemake-executor-plugin-wasm/.pixi/envs/default/bin/python` and falls back to `python3`.
Pyodide is installed from npm and synced to `static/pyodide` so the worker can load it with `indexURL: '/pyodide/'`.

```sh
npm run sync:assets
```

## Develop

```sh
npm run dev
```

## Type-check

```sh
npm run check
```

## Build

```sh
npm run build:app
```

or directly:

```sh
npm run build
```

## Preview production build

```sh
npm run preview
```
