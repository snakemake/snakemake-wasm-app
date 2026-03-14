# Snakemake WASM App

Run Snakemake workflows directly in the browser with a local, interactive IDE powered by Pyodide, web workers, webR, and a WASM Linux runtime.

## Features

- Browser-based Snakemake execution (no backend service required)
- Multi-tab editor for `Snakefile`, `config.yaml`, and additional workflow files
- Runtime file uploads via picker, drag-and-drop, or URL query parameters
- Parallel shell execution with configurable worker count
- Live logs and run stats (status, elapsed time, workers, shell pool, outputs)
- Downloadable workflow outputs from the UI
- Runtime support check with clear browser compatibility messaging

## Browser support

This app requires a browser with WebAssembly JSPI support.

- Recommended: latest Chrome/Chromium
- If unsupported, the app shows an in-app runtime warning

## Quick start

### 1) Install dependencies

```sh
npm install
```

### 2) Sync runtime assets

```sh
npm run sync:assets
```

This syncs:

- `pyodide` assets into `static/pyodide`
- runtime wheels into `static/wheels`
- v86 runtime assets into `static/v86`
- third-party v86 scripts into `static/thirdparty/v86`
- default `Snakefile` into `static/Snakefile`

### 3) Start the app

```sh
npm run dev
```

Open the local URL shown by Vite.

## Typical user workflow

1. Edit `Snakefile` and `config.yaml`.
2. Add extra workflow files as tabs.
3. Upload runtime input files (optional).
4. Set worker count in **Run Controls**.
5. Click **Run**, monitor logs/stats, then download outputs.

## Scripts

- `npm run dev` – start local development server
- `npm run check` – run Svelte/TypeScript checks
- `npm run build` – build production bundle
- `npm run build:app` – run checks, then build
- `npm run preview` – preview production build
- `npm run sync:assets` – sync all runtime assets
- `npm run sync:plugin-wheel` – rebuild and copy plugin wheel

## Troubleshooting

- Runtime initialization error: use latest Chrome/Chromium and refresh.
- Missing outputs: verify expected output paths in your workflow rules.
- Unexpected serial execution: confirm your workflow has multiple runnable jobs and increase worker count.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for developer workflows (plugin tests, wheel sync, and release-related tasks).
