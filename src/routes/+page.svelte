<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { base } from '$app/paths';
	import { Tabs } from '@skeletonlabs/skeleton-svelte';
	import { FileOutput, Logs, Settings2 } from '@lucide/svelte';
	import IdeTabs from '$lib/components/IdeTabs.svelte';
	import type { IdeTabItem } from '$lib/components/IdeTabs.svelte';
	import Navbar from '$lib/components/Navbar.svelte';
	import RuntimeFiles from '$lib/components/RuntimeFiles.svelte';
	import type { RuntimeFileItem } from '$lib/components/RuntimeFiles.svelte';
	import RunControls from '$lib/components/RunControls.svelte';
	import OutputDownloads from '$lib/components/OutputDownloads.svelte';
	import LogPanel from '$lib/components/LogPanel.svelte';
	import { DEFAULT_CONFIG, FALLBACK_SNAKEFILE, RUNTIME_WHEELS } from '$lib/constants/runtime';
	import { bytesToBase64, base64ToBytes } from '$lib/utils/encoding';
	import { normalizeVmOutputPath } from '$lib/utils/files';
	import type { InputFilePayload, OutputFilePayload, ShellSyncedFile, WorkflowResultPayload } from '$lib/types/workflow';
	import { V86Shell, ensureV86ScriptLoaded } from '$lib/v86/v86Shell';

	type PersistedIdeStateV2 = {
		v: 2;
		a: number;
		t: Array<[string, string]>;
	};

	type RestoredIdeState = {
		activePath: string;
		tabs: Array<{
			path: string;
			content: string;
		}>;
	};

	type WorkerInMessage =
		| { type: 'init-ready' }
		| { type: 'init-error'; error: string }
		| { type: 'log'; text: string }
		| { type: 'progress'; payload: Record<string, unknown> }
		| { type: 'result'; payload: WorkflowResultPayload }
		| {
				type: 'shell-run-request';
				requestId: string;
				workerSessionId?: string;
				command: string;
				timeoutMs?: number;
				outputPaths?: string[];
				inputFiles?: InputFilePayload[];
				slotId?: number;
		  }
		| { type: 'error'; error: string };

	type WorkerOutMessage =
		| { type: 'init'; wheels: string[]; pyodideIndexUrl: string; maxParallelJobs?: number }
		| {
				type: 'run';
				snakefile: string;
				configYaml: string;
				files: InputFilePayload[];
				envvars?: Record<string, string>;
				wheels: string[];
				pyodideIndexUrl: string;
				maxParallelJobs?: number;
		  }
		| { type: 'cancel' }
		| {
				type: 'shell-run-response';
				requestId: string;
				workerSessionId?: string;
				ok: boolean;
				stdout?: string;
				stderr?: string;
				exitCode?: number;
				error?: string;
				files?: ShellSyncedFile[];
		  };

	const withBase = (path: string): string => {
		if (path.startsWith('http://') || path.startsWith('https://')) return path;
		const normalized = path.startsWith('/') ? path : `/${path}`;
		return `${base}${normalized}`;
	};

	const PYODIDE_INDEX_URL = withBase('/pyodide/');
	const PLUGIN_WHEEL_FILE = 'snakemake_executor_plugin_wasm-0.1.0-py3-none-any.whl';
	const PLUGIN_WHEEL_CACHE_BUST = `v=${Date.now().toString(36)}`;
	const MAX_CONCURRENT_SHELL_JOBS = 6;
	const DEFAULT_MAX_PARALLEL_JOBS = 1;

	const runtimeWheelUrls = RUNTIME_WHEELS.map((wheelPath) => {
		const url = withBase(wheelPath);
		if (!wheelPath.endsWith(PLUGIN_WHEEL_FILE)) {
			return url;
		}
		return `${url}${url.includes('?') ? '&' : '?'}${PLUGIN_WHEEL_CACHE_BUST}`;
	});

	const v86Config = {
		wasmPath: withBase('/v86/v86.wasm'),
		initialStateUrl: withBase('/v86/alpine-state.bin.zst'),
		initialStateSize: 50 * 1024 * 1024,
		baseUrl: withBase('/v86/alpine-rootfs-flat/'),
		baseFsUrl: withBase('/v86/alpine-fs.json'),
		biosUrl: withBase('/v86/bios/seabios.bin'),
		vgaBiosUrl: withBase('/v86/bios/vgabios.bin'),
		runTimeoutMs: 120000
	};

	const createId = (): string => {
		const cryptoApi = globalThis.crypto;
		if (typeof cryptoApi?.randomUUID === 'function') {
			return cryptoApi.randomUUID();
		}

		if (typeof cryptoApi?.getRandomValues === 'function') {
			const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
			bytes[6] = (bytes[6] & 0x0f) | 0x40;
			bytes[8] = (bytes[8] & 0x3f) | 0x80;
			const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}

		return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	};

	let logs: string[] = [];
	let outputs: OutputFilePayload[] = [];
	let runDisabled = true;
	let isRunning = false;
	let runPending = false;
	let shellReady = false;
	let terminalElement: HTMLDivElement | null = null;
	let tabs: IdeTabItem[] = [
		{ id: createId(), path: 'Snakefile', content: FALLBACK_SNAKEFILE },
		{ id: createId(), path: 'config.yaml', content: DEFAULT_CONFIG }
	];
	let activeTabId = tabs[0]?.id ?? '';
	const uploadedFiles = new Map<string, { payload: InputFilePayload; sizeBytes: number; sourceUrl?: string }>();
	let runtimeFiles: RuntimeFileItem[] = [];
	let outputUrls: string[] = [];
	let runtimeSupportMessage: string | null = null;
	let maxParallelJobs = DEFAULT_MAX_PARALLEL_JOBS;
	let envVarsInput = '';
	let runStartedAt: number | null = null;
	let runElapsedMs = 0;
	let runElapsedTimer: ReturnType<typeof setInterval> | null = null;

	let worker: Worker | null = null;
	let workerRuntimeReady = false;
	let workerRuntimeInitInFlight: Promise<void> | null = null;
	let workerRuntimeInitResolve: (() => void) | null = null;
	let workerRuntimeInitReject: ((error: Error) => void) | null = null;
	let workerInitSupported = true;
	let ideUrlSyncReady = false;
	let ideUrlPersistTimer: ReturnType<typeof setTimeout> | null = null;

	const v86ShellPool = new Map<number, V86Shell>();
	const v86ShellInitInFlight = new Map<number, Promise<V86Shell>>();

	const IDE_STATE_HASH_KEY = 'code';
	const ENV_VARS_HASH_KEY = 'env';
	const RUNTIME_FILES_PARAM_KEY = 'runtimefiles';
	const WORKFLOW_TITLE_PARAM_KEY = 'title';

	let workflowTitle = '';

	const toBase64Url = (input: string): string =>
		input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

	const fromBase64Url = (input: string): string => {
		const padded = input.replace(/-/g, '+').replace(/_/g, '/');
		const padLen = (4 - (padded.length % 4)) % 4;
		return padded + '='.repeat(padLen);
	};

	const serializeIdeState = (): string => {
		const activeIndex = Math.max(
			0,
			tabs.findIndex((tab) => tab.id === activeTabId)
		);
		const payload: PersistedIdeStateV2 = {
			v: 2,
			a: activeIndex,
			t: tabs.map((tab) => [tab.path, tab.content])
		};
		const json = JSON.stringify(payload);
		const bytes = new TextEncoder().encode(json);
		return toBase64Url(bytesToBase64(bytes));
	};

	const parseIdeStateFromHash = (): RestoredIdeState | null => {
		const rawHash = window.location.hash.replace(/^#/, '');
		if (!rawHash) return null;

		const hashParams = new URLSearchParams(rawHash);
		const encoded = hashParams.get(IDE_STATE_HASH_KEY);
		if (!encoded) return null;

		try {
			const base64 = fromBase64Url(encoded);
			const bytes = base64ToBytes(base64);
			const json = new TextDecoder().decode(bytes);
			const parsed = JSON.parse(json) as PersistedIdeStateV2;

			if (parsed?.v === 2 && Array.isArray(parsed.t) && parsed.t.length > 0) {
				const sanitizedTabs = parsed.t
					.filter((tab) => Array.isArray(tab) && typeof tab[0] === 'string' && typeof tab[1] === 'string')
					.map((tab) => ({ path: tab[0].trim(), content: tab[1] }))
					.filter((tab) => tab.path.length > 0);

				if (sanitizedTabs.length === 0) return null;

				const activeIndex =
					typeof parsed.a === 'number' && Number.isInteger(parsed.a) && parsed.a >= 0
						? Math.min(parsed.a, sanitizedTabs.length - 1)
						: 0;

				return {
					activePath: sanitizedTabs[activeIndex]?.path ?? sanitizedTabs[0].path,
					tabs: sanitizedTabs
				};
			}

			return null;
		} catch {
			return null;
		}
	};

	const applyIdeStateFromUrl = (): boolean => {
		const persisted = parseIdeStateFromHash();
		if (!persisted) return false;

		const restoredTabs: IdeTabItem[] = persisted.tabs.map((tab) => ({
			id: createId(),
			path: tab.path,
			content: tab.content
		}));

		tabs = restoredTabs;

		const active = restoredTabs.find((tab) => tab.path === persisted.activePath) ?? restoredTabs[0];
		activeTabId = active?.id ?? '';
		appendLog('[ui] restored IDE state from URL');
		return true;
	};

	const restoreEnvVarsFromHash = () => {
		const rawHash = window.location.hash.replace(/^#/, '');
		if (!rawHash) {
			envVarsInput = '';
			return;
		}

		const hashParams = new URLSearchParams(rawHash);
		const encoded = hashParams.get(ENV_VARS_HASH_KEY);
		if (!encoded) {
			envVarsInput = '';
			return;
		}

		try {
			const base64 = fromBase64Url(encoded);
			const bytes = base64ToBytes(base64);
			envVarsInput = new TextDecoder().decode(bytes);
		} catch {
			envVarsInput = '';
		}
	};

	const persistIdeStateToUrl = () => {
		const encoded = serializeIdeState();
		const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
		hashParams.set(IDE_STATE_HASH_KEY, encoded);

		const normalizedEnvInput = String(envVarsInput ?? '');
		if (normalizedEnvInput.trim().length > 0) {
			const envBytes = new TextEncoder().encode(normalizedEnvInput);
			hashParams.set(ENV_VARS_HASH_KEY, toBase64Url(bytesToBase64(envBytes)));
		} else {
			hashParams.delete(ENV_VARS_HASH_KEY);
		}

		const nextHash = hashParams.toString();
		const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
		window.history.replaceState(window.history.state, '', nextUrl);
	};

	const scheduleIdeStatePersist = () => {
		if (!ideUrlSyncReady) return;
		if (ideUrlPersistTimer) window.clearTimeout(ideUrlPersistTimer);
		ideUrlPersistTimer = window.setTimeout(() => {
			persistIdeStateToUrl();
			ideUrlPersistTimer = null;
		}, 250);
	};

	const applyWorkflowTitleFromUrl = () => {
		const searchParams = new URLSearchParams(window.location.search);
		workflowTitle = (searchParams.get(WORKFLOW_TITLE_PARAM_KEY) ?? '').trim();
	};

	const persistWorkflowTitleToUrl = (nextTitle: string) => {
		const searchParams = new URLSearchParams(window.location.search);
		const trimmedTitle = String(nextTitle ?? '').trim();

		if (trimmedTitle) {
			searchParams.set(WORKFLOW_TITLE_PARAM_KEY, trimmedTitle);
		} else {
			searchParams.delete(WORKFLOW_TITLE_PARAM_KEY);
		}

		const nextSearch = searchParams.toString();
		const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
		window.history.replaceState(window.history.state, '', nextUrl);
	};

	const setWorkflowTitle = (nextTitle: string) => {
		workflowTitle = String(nextTitle ?? '').trim();
		persistWorkflowTitleToUrl(workflowTitle);
	};

	const appendLog = (...parts: unknown[]) => {
		const line = parts
			.map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
			.join(' ');
		logs = [...logs, line];
		console.log(...parts);
	};

	const getWorkerSettingMax = (): number => {
		if (typeof navigator === 'undefined') return 16;
		return Math.max(1, Math.min(16, navigator.hardwareConcurrency ?? 8));
	};

	const clampWorkerCount = (value: number): number => {
		const maxWorkers = getWorkerSettingMax();
		if (!Number.isFinite(value)) return 1;
		return Math.max(1, Math.min(maxWorkers, Math.floor(value)));
	};

	const setWorkerCount = (rawValue: string) => {
		maxParallelJobs = clampWorkerCount(Number(rawValue));
	};

	const parseEnvVarsInput = (
		rawInput: string
	): { envvars: Record<string, string>; invalidLines: string[] } => {
		const envvars: Record<string, string> = {};
		const invalidLines: string[] = [];
		const lines = String(rawInput ?? '').split(/\r?\n/);

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const separatorIndex = trimmed.indexOf('=');
			if (separatorIndex <= 0) {
				invalidLines.push(trimmed);
				continue;
			}

			const key = trimmed.slice(0, separatorIndex).trim();
			const value = trimmed.slice(separatorIndex + 1);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				invalidLines.push(trimmed);
				continue;
			}

			envvars[key] = value;
		}

		return { envvars, invalidLines };
	};

	const toRuntimeSupportMessage = (errorText: string): string | null => {
		if (!errorText) return null;
		if (errorText.includes('can_run_sync')) {
			return 'Snakemake Wasm is not supported in this browser. Please use the latest version of Chrome.';
		}
		return null;
	};

	const setTerminalRef = (element: HTMLDivElement | null) => {
		terminalElement = element;
	};

	const clearOutputUrls = () => {
		for (const url of outputUrls) URL.revokeObjectURL(url);
		outputUrls = [];
	};

	const stopRunTimer = () => {
		if (runElapsedTimer) {
			clearInterval(runElapsedTimer);
			runElapsedTimer = null;
		}
	};

	const startRunTimer = () => {
		runStartedAt = Date.now();
		runElapsedMs = 0;
		stopRunTimer();
		runElapsedTimer = setInterval(() => {
			if (!runStartedAt) return;
			runElapsedMs = Math.max(0, Date.now() - runStartedAt);
		}, 1000);
	};

	const formatElapsed = (elapsedMs: number): string => {
		const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
		const minutes = Math.floor(totalSeconds / 60)
			.toString()
			.padStart(2, '0');
		const seconds = (totalSeconds % 60).toString().padStart(2, '0');
		return `${minutes}:${seconds}`;
	};

	$: logStats = {
		status: isRunning ? 'running' : runPending ? 'starting' : 'idle',
		workerRuntime: workerRuntimeReady ? 'ready' : 'warming',
		shellPool: v86ShellPool.size,
		workers: maxParallelJobs,
		logs: logs.length,
		outputs: outputs.length,
		runtimeFiles: runtimeFiles.length,
		elapsed: formatElapsed(runElapsedMs)
	};

	const refreshUploadedFilePaths = () => {
		runtimeFiles = [...uploadedFiles.entries()]
			.map(([path, entry]) => ({ path, sizeBytes: entry.sizeBytes, sourceUrl: entry.sourceUrl }))
			.sort((a, b) => a.path.localeCompare(b.path));
	};

	const makeUniqueUploadPath = (basePath: string): string => {
		const normalized = basePath.trim().replace(/^\/+/, '');
		const path = normalized || 'upload.bin';
		if (!uploadedFiles.has(path)) return path;

		const dotIndex = path.lastIndexOf('.');
		const stem = dotIndex > 0 ? path.slice(0, dotIndex) : path;
		const ext = dotIndex > 0 ? path.slice(dotIndex) : '';
		let idx = 1;
		let candidate = `${stem}_${idx}${ext}`;
		while (uploadedFiles.has(candidate)) {
			idx += 1;
			candidate = `${stem}_${idx}${ext}`;
		}
		return candidate;
	};

	const ingestRuntimeFiles = async (fileList: FileList | null) => {
		if (!fileList || fileList.length === 0) return;

		for (const file of Array.from(fileList)) {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const desiredPath = `data/${file.name}`;
			const finalPath = makeUniqueUploadPath(desiredPath);
			uploadedFiles.set(finalPath, {
				payload: {
					path: finalPath,
					encoding: 'base64',
					content: bytesToBase64(bytes)
				},
				sizeBytes: bytes.length,
				sourceUrl: undefined
			});
		}

		refreshUploadedFilePaths();
		appendLog('[ui] runtime files queued', fileList.length);
	};

	const collectRuntimeFileUrls = (params: URLSearchParams): string[] => {
		const values = params.getAll(RUNTIME_FILES_PARAM_KEY);
		if (values.length === 0) return [];

		return values
			.flatMap((value) => value.split(','))
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
	};

	const runtimeFileNameFromUrl = (url: URL, index: number): string => {
		const pathname = url.pathname;
		const segment = pathname.split('/').filter(Boolean).at(-1) ?? '';
		const decoded = segment ? decodeURIComponent(segment) : '';
		const sanitized = decoded.replace(/[/\\]/g, '').trim();
		if (sanitized.length > 0) return sanitized;
		return `runtime_${index + 1}.bin`;
	};

	const ingestRuntimeFilesFromUrlParams = async () => {
		const searchParams = new URLSearchParams(window.location.search);
		const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
		const requestedUrls = [...collectRuntimeFileUrls(searchParams), ...collectRuntimeFileUrls(hashParams)];
		if (requestedUrls.length === 0) return;

		const uniqueUrls = [...new Set(requestedUrls)];
		appendLog('[ui] runtimefiles: loading from URL params', uniqueUrls.length);

		let addedCount = 0;

		for (let index = 0; index < uniqueUrls.length; index += 1) {
			const rawUrl = uniqueUrls[index];

			try {
				const parsedUrl = new URL(rawUrl);
				if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
					appendLog('[ui] runtimefiles: skipped unsupported URL scheme', rawUrl);
					continue;
				}

				const response = await fetch(parsedUrl.toString());
				if (!response.ok) {
					appendLog('[ui] runtimefiles: failed to fetch', parsedUrl.toString(), `HTTP ${response.status}`);
					continue;
				}

				const bytes = new Uint8Array(await response.arrayBuffer());
				const fileName = runtimeFileNameFromUrl(parsedUrl, index);
				const desiredPath = `data/${fileName}`;
				const finalPath = makeUniqueUploadPath(desiredPath);
				uploadedFiles.set(finalPath, {
					payload: {
						path: finalPath,
						encoding: 'base64',
						content: bytesToBase64(bytes)
					},
					sizeBytes: bytes.length,
					sourceUrl: parsedUrl.toString()
				});
				addedCount += 1;
				appendLog('[ui] runtimefiles: loaded', parsedUrl.toString(), `-> ${finalPath}`);
			} catch (error) {
				appendLog('[ui] runtimefiles: failed to load', rawUrl, String(error));
			}
		}

		if (addedCount > 0) {
			refreshUploadedFilePaths();
			appendLog('[ui] runtimefiles: queued from URL params', addedCount);
		}
	};

	const createUntitledTab = (): IdeTabItem => {
		const existing = new Set(tabs.map((tab) => tab.path.trim()));
		let index = 1;
		let candidate = `file${index}.txt`;
		while (existing.has(candidate)) {
			index += 1;
			candidate = `file${index}.txt`;
		}
		return { id: createId(), path: candidate, content: '' };
	};

	const selectTab = (id: string) => {
		activeTabId = id;
	};

	const addTab = () => {
		const newTab = createUntitledTab();
		tabs = [...tabs, newTab];
		activeTabId = newTab.id;
	};

	const renameTab = (id: string, nextPath: string) => {
		tabs = tabs.map((tab) => (tab.id === id ? { ...tab, path: nextPath } : tab));
	};

	const deleteTab = (id: string) => {
		if (tabs.length <= 1) {
			appendLog('[ui] cannot delete the last tab');
			return;
		}

		const idx = tabs.findIndex((tab) => tab.id === id);
		if (idx === -1) return;

		const remaining = tabs.filter((tab) => tab.id !== id);
		tabs = remaining;

		if (activeTabId === id) {
			const nextTab = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
			activeTabId = nextTab?.id ?? '';
		}
	};

	const updateTabContent = (id: string, nextContent: string) => {
		tabs = tabs.map((tab) => (tab.id === id ? { ...tab, content: nextContent } : tab));
	};

	const resetWorkerRuntimeInitLatch = () => {
		workerRuntimeInitInFlight = null;
		workerRuntimeInitResolve = null;
		workerRuntimeInitReject = null;
	};

	const restartWorkerForRun = () => {
		appendLog('[ui] restartWorkerForRun: resetting worker/runtime state');
		workerRuntimeReady = false;
		workerInitSupported = true;
		resetWorkerRuntimeInitLatch();
		if (worker) {
			worker.terminate();
			worker = null;
		}
		setupWorker();
	};

	const inferOutputMimeType = (path: string, fallback: string): string => {
		const normalized = String(path ?? '').trim().toLowerCase();
		const extension = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1) : '';

		switch (extension) {
			case 'txt':
			case 'log':
			case 'md':
				return 'text/plain;charset=utf-8';
			case 'csv':
				return 'text/csv;charset=utf-8';
			case 'tsv':
				return 'text/tab-separated-values;charset=utf-8';
			case 'json':
				return 'application/json;charset=utf-8';
			case 'yaml':
			case 'yml':
				return 'application/yaml;charset=utf-8';
			case 'html':
			case 'htm':
				return 'text/html;charset=utf-8';
			case 'svg':
				return 'image/svg+xml';
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'gif':
				return 'image/gif';
			case 'webp':
				return 'image/webp';
			case 'pdf':
				return 'application/pdf';
			default:
				return fallback;
		}
	};

	const toDownloadUrl = (file: OutputFilePayload): { href: string; label: string } | null => {
		const label = String(file.path ?? '');
		let blob: Blob | null = null;
		if (file.encoding === 'utf-8') {
			blob = new Blob([String(file.text ?? '')], {
				type: inferOutputMimeType(label, 'text/plain;charset=utf-8')
			});
		} else if (file.encoding === 'base64') {
			const bytes = base64ToBytes(String(file.base64 ?? ''));
			const arrayBuffer = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength
			) as ArrayBuffer;
			blob = new Blob([arrayBuffer], { type: inferOutputMimeType(label, 'application/octet-stream') });
		}

		if (!blob) return null;
		const href = URL.createObjectURL(blob);
		outputUrls.push(href);
		return { href, label };
	};

	const loadDefaultSnakefile = async () => {
		try {
			const response = await fetch(withBase('/Snakefile'));
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text = await response.text();
			tabs = tabs.map((tab) => (tab.path.trim() === 'Snakefile' ? { ...tab, content: text } : tab));
			appendLog('[ui] loaded default workflow from', withBase('/Snakefile'));
		} catch (error) {
			appendLog('[ui] failed to load Snakefile from base path, using fallback workflow', String(error));
		}
	};

	const buildRunInputsFromTabs = (): {
		snakefile: string;
		configYaml: string;
		files: InputFilePayload[];
		runtimeFileCount: number;
	} | null => {
		const normalized = tabs.map((tab) => ({
			id: tab.id,
			path: tab.path.trim(),
			content: tab.content
		}));

		for (const tab of normalized) {
			if (!tab.path) {
				appendLog('[error] one or more tabs have an empty filename');
				return null;
			}
			if (tab.path.startsWith('/') || tab.path.includes('..')) {
				appendLog('[error] invalid tab filename:', tab.path);
				return null;
			}
		}

		const uniquePaths = new Set<string>();
		for (const tab of normalized) {
			if (uniquePaths.has(tab.path)) {
				appendLog('[error] duplicate tab filename:', tab.path);
				return null;
			}
			uniquePaths.add(tab.path);
		}

		for (const uploadedPath of uploadedFiles.keys()) {
			if (uniquePaths.has(uploadedPath)) {
				appendLog('[error] filename conflicts with uploaded runtime file:', uploadedPath);
				return null;
			}
			uniquePaths.add(uploadedPath);
		}

		const snakefileTab = normalized.find((tab) => tab.path === 'Snakefile');
		const configTab = normalized.find((tab) => tab.path === 'config.yaml');

		const snakefile = snakefileTab?.content?.length ? snakefileTab.content : FALLBACK_SNAKEFILE;
		const configYaml = configTab?.content?.length ? configTab.content : DEFAULT_CONFIG;

		const files: InputFilePayload[] = normalized
			.filter((tab) => tab.path !== 'Snakefile' && tab.path !== 'config.yaml')
			.map((tab) => ({
				path: tab.path,
				encoding: 'utf-8',
				content: tab.content
			}));

		for (const runtimeFile of uploadedFiles.values()) {
			files.push(runtimeFile.payload);
		}

		return { snakefile, configYaml, files, runtimeFileCount: uploadedFiles.size };
	};

	const removeRuntimeFile = (path: string) => {
		if (uploadedFiles.delete(path)) {
			refreshUploadedFilePaths();
			appendLog('[ui] removed runtime file', path);
		}
	};

	const ensureShell = async (slotId = 0): Promise<V86Shell> => {
		appendLog('[ui] ensureShell: requested', { slotId, hasExisting: v86ShellPool.has(slotId), hasInFlight: v86ShellInitInFlight.has(slotId) });
		const existing = v86ShellPool.get(slotId);
		if (existing) {
			appendLog('[ui] ensureShell: reusing existing shell', { slotId });
			return existing;
		}

		const inFlight = v86ShellInitInFlight.get(slotId);
		if (inFlight) {
			appendLog('[ui] ensureShell: awaiting in-flight init', { slotId });
			return inFlight;
		}

		const initPromise = (async () => {
			appendLog('[ui] ensureShell: loading v86 script', { slotId });
			await ensureV86ScriptLoaded(withBase('/thirdparty/v86/libv86.js'));
			appendLog('[ui] ensureShell: v86 script loaded', { slotId });

			appendLog('[ui] ensureShell: creating V86Shell instance', { slotId, hasTerminalEl: slotId === 0 ? Boolean(terminalElement) : false });
			const shell = new V86Shell({
				...v86Config,
				terminalEl: slotId === 0 ? terminalElement : null,
				onLog: (message) => appendLog(`[v86:${slotId}]`, message)
			});
			appendLog('[ui] ensureShell: calling shell.init()', { slotId });
			await shell.init();
			appendLog('[ui] ensureShell: shell.init() resolved', { slotId });
			v86ShellPool.set(slotId, shell);
			shellReady = true;
			appendLog('[ui] ensureShell: shell stored and ready', { slotId, poolSize: v86ShellPool.size });
			return shell;
		})();

		v86ShellInitInFlight.set(slotId, initPromise);
		appendLog('[ui] ensureShell: init promise stored', { slotId, inFlightSize: v86ShellInitInFlight.size });
		try {
			const shell = await initPromise;
			appendLog('[ui] ensureShell: returning initialized shell', { slotId });
			return shell;
		} finally {
			v86ShellInitInFlight.delete(slotId);
			appendLog('[ui] ensureShell: cleared in-flight marker', { slotId, inFlightSize: v86ShellInitInFlight.size });
		}
	};

	const syncShellInputFiles = async (shell: V86Shell, inputFiles: InputFilePayload[]): Promise<void> => {
		for (const inputFile of inputFiles) {
			const vmPath = normalizeVmOutputPath(inputFile.path);
			if (!vmPath) {
				appendLog('[pathmap] shell input skipped', { relativePath: inputFile.path, vmPath: null });
				continue;
			}
			appendLog('[pathmap] shell input', { relativePath: inputFile.path, vmPath });

			try {
				if (inputFile.encoding === 'base64') {
					await shell.writeFile(vmPath, base64ToBytes(String(inputFile.content ?? '')));
				} else {
					await shell.writeFile(vmPath, new TextEncoder().encode(String(inputFile.content ?? '')));
				}
			} catch (error) {
				appendLog('[shell] failed to sync input', inputFile.path, String(error));
				throw error;
			}
		}
	};

	const ensureShellOutputDirectories = async (shell: V86Shell, outputPaths: string[]): Promise<void> => {
		const directories = new Set<string>();
		for (const outputPath of outputPaths) {
			const vmPath = normalizeVmOutputPath(outputPath);
			if (!vmPath) {
				appendLog('[pathmap] shell output skipped', { relativePath: outputPath, vmPath: null });
				continue;
			}
			const slashIndex = vmPath.lastIndexOf('/');
			if (slashIndex <= 0) continue;
			const directory = vmPath.slice(0, slashIndex).trim();
			if (!directory || directory === '/root') continue;
			appendLog('[pathmap] shell output dir', { relativePath: outputPath, vmPath, directory });
			directories.add(directory);
		}

		for (const directory of directories) {
			try {
				await shell.ensureDirectory(directory);
				appendLog('[shell] ensured output directory', directory);
			} catch (error) {
				appendLog('[shell] failed to ensure output directory', directory, String(error));
				throw error;
			}
		}
	};

	const collectShellOutputFiles = async (shell: V86Shell, outputPaths: string[]): Promise<ShellSyncedFile[]> => {
		const synced: ShellSyncedFile[] = [];
		for (const outputPath of outputPaths) {
			const vmPath = normalizeVmOutputPath(outputPath);
			if (!vmPath) {
				appendLog('[pathmap] shell collect skipped', { relativePath: outputPath, vmPath: null });
				continue;
			}
			appendLog('[pathmap] shell collect', { relativePath: outputPath, vmPath });

			try {
				const bytes = await shell.readFile(vmPath);
				synced.push({ path: outputPath, encoding: 'base64', base64: bytesToBase64(bytes) });
				appendLog('[shell] synced output', outputPath, `bytes=${bytes.length}`);
			} catch (error) {
				appendLog('[shell] output not found in v86', outputPath, String(error));
			}
		}
		return synced;
	};

	const prewarmWorkerRuntime = (): Promise<void> => {
		if (!workerInitSupported) return Promise.resolve();
		if (workerRuntimeReady) return Promise.resolve();
		if (workerRuntimeInitInFlight) return workerRuntimeInitInFlight;
		if (!worker) return Promise.reject(new Error('Worker not initialized'));

		workerRuntimeInitInFlight = new Promise<void>((resolve, reject) => {
			workerRuntimeInitResolve = resolve;
			workerRuntimeInitReject = reject;
		});

		appendLog('[ui] prewarm: worker runtime starting');
		worker.postMessage({
			type: 'init',
			wheels: runtimeWheelUrls,
			pyodideIndexUrl: PYODIDE_INDEX_URL,
			maxParallelJobs
		} satisfies WorkerOutMessage);

		return workerRuntimeInitInFlight;
	};

	const setupWorker = () => {
		worker = new Worker(new URL('../lib/workers/snakemakeMainWorker.ts', import.meta.url), {
			type: 'module'
		});
		const sourceWorker = worker;

		worker.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
			const msg = event.data;
			if (msg.type === 'log') {
				appendLog(msg.text ?? '');
				return;
			}
			if (msg.type === 'progress') {
				appendLog('[progress]', msg.payload ?? {});
				const stage = String(msg.payload?.stage ?? '');
				const status = String(msg.payload?.status ?? '');
				if (stage === 'workflow' && status === 'running') {
					if (!runStartedAt) startRunTimer();
					isRunning = true;
				}
				if (stage === 'workflow' && status === 'finished') {
					isRunning = false;
					runPending = false;
					runDisabled = false;
					stopRunTimer();
				}
				return;
			}
			if (msg.type === 'result') {
				clearOutputUrls();
				outputs = Array.isArray(msg.payload?.output_files) ? msg.payload.output_files : [];
				isRunning = false;
				runPending = false;
				runDisabled = false;
				stopRunTimer();
				return;
			}
			if (msg.type === 'init-ready') {
				workerRuntimeReady = true;
				runDisabled = runPending ? true : false;
				runtimeSupportMessage = null;
				workerRuntimeInitResolve?.();
				resetWorkerRuntimeInitLatch();
				appendLog('[ui] prewarm: worker runtime ready');
				return;
			}
			if (msg.type === 'init-error') {
				workerRuntimeReady = false;
				runDisabled = runPending ? true : false;
				runtimeSupportMessage = toRuntimeSupportMessage(String(msg.error ?? ''));
				workerRuntimeInitReject?.(new Error(msg.error ?? 'unknown'));
				resetWorkerRuntimeInitLatch();
				appendLog('[ui] prewarm: worker runtime failed', msg.error ?? 'unknown');
				return;
			}
			if (msg.type === 'shell-run-request') {
				const requestId = String(msg.requestId ?? '');
				const workerSessionId = String(msg.workerSessionId ?? '');
				const command = String(msg.command ?? '');
				const outputPaths = Array.isArray(msg.outputPaths) ? msg.outputPaths : [];
				const inputFiles = Array.isArray(msg.inputFiles) ? msg.inputFiles : [];
				const slotId = Number.isFinite(msg.slotId) ? Math.max(0, Math.floor(Number(msg.slotId))) : 0;
				appendLog('[shell] request', requestId, { workerSessionId, slotId, command });

				try {
					const shell = await ensureShell(slotId);
					await syncShellInputFiles(shell, inputFiles);
					await ensureShellOutputDirectories(shell, outputPaths);
					const result = await shell.run(command, { timeoutMs: Number(msg.timeoutMs ?? 300000) });
					const syncedFiles = await collectShellOutputFiles(shell, outputPaths);
					sourceWorker.postMessage({
						type: 'shell-run-response',
						requestId,
						workerSessionId,
						ok: true,
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
						files: syncedFiles
					} satisfies WorkerOutMessage);
					appendLog('[shell] response posted', requestId, {
						ok: true,
						files: syncedFiles.length,
						workerSessionId,
						workerMatchesGlobal: sourceWorker === worker
					});
					appendLog('[shell] success', requestId, `exit=${result.exitCode}`);
				} catch (error) {
					sourceWorker.postMessage({
						type: 'shell-run-response',
						requestId,
						workerSessionId,
						ok: false,
						error: String(error)
					} satisfies WorkerOutMessage);
					appendLog('[shell] response posted', requestId, {
						ok: false,
						workerSessionId,
						workerMatchesGlobal: sourceWorker === worker
					});
					appendLog('[shell] error', requestId, String(error));
				}
				return;
			}
			if (msg.type === 'error') {
				const errorText = String(msg.error ?? 'Unknown worker error');
				if (workerRuntimeInitInFlight && errorText.includes('Unsupported message type: init')) {
					workerInitSupported = false;
					workerRuntimeReady = false;
					runDisabled = runPending ? true : false;
					workerRuntimeInitResolve?.();
					resetWorkerRuntimeInitLatch();
					appendLog('[ui] prewarm: worker init not supported, falling back to run-time init');
					return;
				}
				appendLog('[error]', errorText);
				runtimeSupportMessage = toRuntimeSupportMessage(errorText);
				isRunning = false;
				runPending = false;
				runDisabled = false;
				stopRunTimer();
			}
		};

		worker.onerror = (event) => {
			appendLog('[worker onerror]', event.message, event.filename, event.lineno, event.colno);
			runtimeSupportMessage = toRuntimeSupportMessage(String(event.message ?? ''));
			isRunning = false;
			runPending = false;
			runDisabled = false;
			stopRunTimer();
		};
	};

	const runWorkflow = async () => {
		restartWorkerForRun();
		if (!worker) return;
		const runInputs = buildRunInputsFromTabs();
		if (!runInputs) return;
		const envVarParse = parseEnvVarsInput(envVarsInput);
		const envvars = envVarParse.envvars;
		if (envVarParse.invalidLines.length > 0) {
			appendLog('[ui] invalid env var lines skipped', envVarParse.invalidLines);
		}
		runtimeSupportMessage = null;

		runPending = true;
		runDisabled = true;
		isRunning = false;
		runStartedAt = null;
		stopRunTimer();
		runElapsedMs = 0;
		outputs = [];
		clearOutputUrls();

		try {
			appendLog('[ui] runWorkflow: prewarmWorkerRuntime start');
			await prewarmWorkerRuntime();
			appendLog('[ui] runWorkflow: prewarmWorkerRuntime done');
			appendLog('[ui] ensuring shell is ready before run');
			appendLog('[ui] runWorkflow: ensureShell start', { slotId: 0 });
			await ensureShell();
			appendLog('[ui] runWorkflow: ensureShell done', { slotId: 0 });

			const effectiveShellParallel = Math.max(1, Math.min(MAX_CONCURRENT_SHELL_JOBS, maxParallelJobs));
			if (effectiveShellParallel > 1) {
				appendLog('[ui] runWorkflow: prewarming shell slots', {
					effectiveShellParallel,
				});
				const warmups: Promise<V86Shell>[] = [];
				for (let slotId = 1; slotId < effectiveShellParallel; slotId += 1) {
					warmups.push(ensureShell(slotId));
				}
				await Promise.all(warmups);
				appendLog('[ui] runWorkflow: shell slot prewarm complete', {
					effectiveShellParallel,
				});
			}
		} catch (error) {
			appendLog('[error]', String(error));
			isRunning = false;
			runPending = false;
			runDisabled = false;
			stopRunTimer();
			return;
		}

		isRunning = true;
		startRunTimer();

		appendLog('[ui] copying runtime files into WASM FS', runInputs.runtimeFileCount);
		if (runInputs.runtimeFileCount > 0) {
			appendLog('[ui] runtime files', runtimeFiles.map((file) => file.path));
		}

		worker.postMessage({
			type: 'run',
			snakefile: runInputs.snakefile,
			configYaml: runInputs.configYaml,
			files: runInputs.files,
			envvars,
			wheels: runtimeWheelUrls,
			pyodideIndexUrl: PYODIDE_INDEX_URL,
			maxParallelJobs
		} satisfies WorkerOutMessage);
		appendLog('[ui] runWorkflow: worker.postMessage(run) sent', {
			filesCount: runInputs.files.length,
			runtimeFileCount: runInputs.runtimeFileCount,
			envVarCount: Object.keys(envvars).length,
			maxParallelJobs
		});

		appendLog('[ui] run requested', workerRuntimeReady ? '(runtime prewarmed)' : '(runtime initializing)');
	};

	const cancelWorkflow = () => worker?.postMessage({ type: 'cancel' } satisfies WorkerOutMessage);

	const clearLogs = () => {
		logs = [];
	};

	$: tabs, activeTabId, envVarsInput, scheduleIdeStatePersist();

	onMount(() => {
		applyWorkflowTitleFromUrl();
		setupWorker();
		const restoredFromUrl = applyIdeStateFromUrl();
		restoreEnvVarsFromHash();
		ideUrlSyncReady = true;
		scheduleIdeStatePersist();

		const onWindowDragOver = (event: DragEvent) => {
			event.preventDefault();
		};

		const onWindowDrop = (event: DragEvent) => {
			event.preventDefault();
			void ingestRuntimeFiles(event.dataTransfer?.files ?? null);
		};

		window.addEventListener('dragover', onWindowDragOver);
		window.addEventListener('drop', onWindowDrop);

		const initAsync = async () => {
			if (!restoredFromUrl) {
				await loadDefaultSnakefile();
			}

			await ingestRuntimeFilesFromUrlParams();

			appendLog('[ui] onMount: starting shell prewarm');
			ensureShell()
				.then(() => appendLog('[v86] prewarm: ready'))
				.catch((error) => appendLog('[v86] prewarm failed', String(error)));

			window.addEventListener('load', () => {
				void prewarmWorkerRuntime();
			});

			if (document.readyState === 'complete') {
				void prewarmWorkerRuntime();
			}
		};

		void initAsync();

		return () => {
			if (ideUrlPersistTimer) {
				window.clearTimeout(ideUrlPersistTimer);
				ideUrlPersistTimer = null;
			}
			window.removeEventListener('dragover', onWindowDragOver);
			window.removeEventListener('drop', onWindowDrop);
		};
	});

	onDestroy(() => {
		stopRunTimer();
		runStartedAt = null;
		clearOutputUrls();
		for (const shell of v86ShellPool.values()) {
			shell.destroy();
		}
		v86ShellPool.clear();
		v86ShellInitInFlight.clear();
		worker?.terminate();
		worker = null;
	});
</script>

<div class="h-dvh w-full overflow-hidden flex flex-col">
	<Navbar title={workflowTitle} onTitleChange={setWorkflowTitle} />

	<main class="w-full flex-1 min-h-0 px-4 py-4 overflow-hidden">
	<div class="grid grid-cols-1 gap-4 lg:h-full xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
		<section class="min-h-0 flex flex-col gap-2 bg-slate-50">
			<div class="min-h-0 flex-1 ">
				<IdeTabs
					{tabs}
					{activeTabId}
					onSelect={selectTab}
					onAdd={addTab}
					onRename={renameTab}
					onDelete={deleteTab}
					onContentChange={updateTabContent}
				/>
			</div>
			<RuntimeFiles files={runtimeFiles} onFilePick={ingestRuntimeFiles} onRemove={removeRuntimeFile} />
		</section>

		<section class="space-y-4 min-h-0 lg:overflow-hidden lg:pr-1 lg:flex lg:flex-col">
			<div class="border border-slate-200 bg-slate-50 p-2 lg:shrink-0 ">
				<RunControls
					runDisabled={runDisabled}
					onRun={runWorkflow}
					onCancel={cancelWorkflow}
					onClear={clearLogs}
					workerCount={maxParallelJobs}
					workerCountMax={getWorkerSettingMax()}
					onWorkerCountChange={setWorkerCount}
				/>
				<!-- <div class="mt-2 border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
					{#if isRunning}
						Workflow status: running
					{:else}
						Workflow status: idle
					{/if}
					 • Shell: {shellReady ? 'ready' : 'warming'}
				</div> -->
			</div>

			<div class="border border-slate-200 bg-slate-50 p-0 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
				<Tabs defaultValue="logs" class="flex flex-col lg:h-full lg:min-h-0">
					<Tabs.List class="flex border-b border-slate-200 overflow-x-auto lg:shrink-0 mb-0">
						<Tabs.Trigger value="logs" class="flex-1" >
							<div class="flex items-center gap-2"><Logs class="size-4" />Logs</div>
						</Tabs.Trigger>
						<Tabs.Trigger value="output" class="flex-1">
							<div class="flex items-center gap-2">
								<FileOutput class="size-4" />
								Output
								<span class="inline-flex min-w-5 items-center justify-center rounded-full border border-blue-300 bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-blue-800">
									{outputs.length}
								</span>
							</div>
						</Tabs.Trigger>
						<Tabs.Trigger value="envvars" class="flex-1">
							<div class="flex items-center gap-2"><Settings2 class="size-4" />Config</div>
						</Tabs.Trigger>
						<Tabs.Indicator />
					</Tabs.List>

					<Tabs.Content value="logs" class="p-2 lg:flex-1 lg:min-h-0 lg:overflow-auto">
						<div class="lg:h-full lg:min-h-0">
							<LogPanel {logs} stats={logStats} terminalRef={setTerminalRef} />
						</div>
					</Tabs.Content>

					<Tabs.Content value="output" class="p-2 lg:flex-1 lg:min-h-0 lg:overflow-auto">
						<OutputDownloads outputs={outputs} {toDownloadUrl} />
					</Tabs.Content>

					<Tabs.Content value="envvars" class="p-2 lg:flex-1 lg:min-h-0 lg:overflow-auto">
						<div class="border border-slate-200 bg-white p-2">
							<label for="envvars-input" class="block text-xs font-medium text-slate-700">Environment Variables</label>
							<p class="mt-1 text-xs text-slate-500">One per line as <code>KEY=VALUE</code>. Example: <code>FEATURE_TEST_TOKEN=abc123</code></p>
							<textarea
								id="envvars-input"
								class="mt-2 h-40 w-full resize-y border border-slate-300 p-2 text-xs font-mono"
								placeholder="FEATURE_TEST_TOKEN=..."
								bind:value={envVarsInput}
							></textarea>
						</div>
					</Tabs.Content>
				</Tabs>
			</div>
		</section>
	</div>
	</main>
</div>

{#if runtimeSupportMessage}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-live="assertive">
		<div class="w-full max-w-md rounded border border-red-300 bg-white p-4 text-center shadow">
			<p class="text-sm text-slate-800">{runtimeSupportMessage}</p>
			<div class="mt-3">
				<button
					type="button"
					class="rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50"
					onclick={() => (runtimeSupportMessage = null)}
				>
					OK
				</button>
			</div>
		</div>
	</div>
{/if}
