type LogFn = (message: string) => void;

interface V86Constructor {
	new (options: Record<string, unknown>): V86Instance;
}

interface V86Instance {
	bus: {
		send(channel: string, payload: number): void;
		register(event: string, listener: () => void): void;
	};
	add_listener(channel: string, listener: (byte: number) => void): void;
	create_file(path: string, data: Uint8Array): Promise<void>;
	create_directory(path: string): Promise<void>;
	read_file(path: string): Promise<Uint8Array>;
	destroy?: () => void;
}

export interface ShellRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	raw: string;
}

export interface V86ShellOptions {
	V86?: V86Constructor;
	terminalEl?: HTMLElement | null;
	debugScreenEl?: HTMLElement | null;
	onLog?: LogFn;
	debugLogs?: boolean;
	wasmPath: string;
	initialStateUrl?: string;
	initialStateSize?: number;
	baseUrl?: string;
	baseFsUrl?: string;
	biosUrl?: string;
	vgaBiosUrl?: string;
	memorySize?: number;
	vgaMemorySize?: number;
	autostart?: boolean;
	disableMouse?: boolean;
	disableSpeaker?: boolean;
	cmdline?: string;
	bootTimeoutMs?: number;
	runTimeoutMs?: number;
	promptRegex?: RegExp;
	startupProbeCommand?: string;
	initCommand?: string;
}

interface PendingRun {
	id: string;
	command: string;
	startMarker: string;
	endMarker: string;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: ShellRunResult) => void;
	reject: (error: Error) => void;
}

const BUS_INPUT = 'serial0-input';
const BUS_OUTPUT = 'serial0-output-byte';
const BUS_OUTPUT_CUSTOM_COMMAND = 'serial1-output-byte';

export async function ensureV86ScriptLoaded(src = '/thirdparty/v86/libv86.js'): Promise<void> {
	if (typeof window === 'undefined') return;
	if ((window as unknown as { V86?: unknown }).V86) return;

	await new Promise<void>((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(`script[data-v86="${src}"]`);
		if (existing) {
			existing.addEventListener('load', () => resolve(), { once: true });
			existing.addEventListener('error', () => reject(new Error(`Failed loading ${src}`)), {
				once: true
			});
			return;
		}

		const script = document.createElement('script');
		script.src = src;
		script.async = true;
		script.dataset.v86 = src;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`Failed loading ${src}`));
		document.head.appendChild(script);
	});
}

export class V86Shell {
	private readonly options: Required<
		Pick<
			V86ShellOptions,
			| 'memorySize'
			| 'vgaMemorySize'
			| 'autostart'
			| 'disableMouse'
			| 'disableSpeaker'
			| 'cmdline'
			| 'bootTimeoutMs'
			| 'runTimeoutMs'
			| 'promptRegex'
			| 'startupProbeCommand'
		>
	> &
		V86ShellOptions;

	private emulator: V86Instance | null = null;
	private terminalEl: HTMLElement | null = null;
	private bootBuffer = '';
	private serialBuffer = '';
	private customBuffer = '';
	private destroyed = false;
	private pendingRuns = new Map<string, PendingRun>();

	constructor(options: V86ShellOptions) {
		this.options = {
			memorySize: 512 * 1024 * 1024,
			vgaMemorySize: 8 * 1024 * 1024,
			autostart: true,
			disableMouse: true,
			disableSpeaker: true,
			cmdline:
				'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable',
			bootTimeoutMs: 120000,
			runTimeoutMs: 30000,
			promptRegex: /(localhost|root|#|\$|❯)/i,
			startupProbeCommand: 'echo __86V_READY__',
			...options
		};

		this.terminalEl = options.terminalEl ?? null;
	}

	private log(...parts: unknown[]): void {
		const message = parts
			.map((part) => {
				if (typeof part === 'string') return part;
				try {
					return JSON.stringify(part);
				} catch {
					return String(part);
				}
			})
			.join(' ');

		this.options.onLog?.(message);
		if (this.options.debugLogs) {
			console.debug('[86vShell]', message);
		}
	}

	async init(): Promise<this> {
		if (this.destroyed) throw new Error('Shell has been destroyed');
		if (this.emulator) return this;

		const globalV86 = (window as unknown as { V86?: V86Constructor }).V86;
		const V86Ctor = this.options.V86 ?? globalV86;
		if (!V86Ctor) throw new Error('V86 constructor not found on window.');

		this.log('init: creating emulator');
		this.emulator = new V86Ctor({
			wasm_path: this.options.wasmPath,
			memory_size: this.options.memorySize,
			vga_memory_size: this.options.vgaMemorySize,
			initial_state: this.options.initialStateUrl
				? { url: this.options.initialStateUrl, size: this.options.initialStateSize }
				: undefined,
			filesystem:
				this.options.baseUrl && this.options.baseFsUrl
					? { baseurl: this.options.baseUrl, basefs: this.options.baseFsUrl }
					: undefined,
			bios: this.options.biosUrl ? { url: this.options.biosUrl, size: 512 * 1024 } : undefined,
			vga_bios: this.options.vgaBiosUrl
				? { url: this.options.vgaBiosUrl, size: 512 * 1024 }
				: undefined,
			autostart: this.options.autostart,
			screen_container: this.options.debugScreenEl ?? null,
			serial_container_xtermjs: this.terminalEl,
			disable_mouse: this.options.disableMouse,
			disable_speaker: this.options.disableSpeaker,
			bzimage_initrd_from_filesystem: true,
			cmdline: this.options.cmdline
		});

		this.attachSerialListeners();
		await this.waitForEmulatorLoaded();
		await this.waitForPrompt();

		if (this.options.startupProbeCommand) {
			const probe = await this.run(this.options.startupProbeCommand, {
				timeoutMs: this.options.runTimeoutMs
			});
			if (probe.exitCode !== 0 || !probe.stdout.includes('__86V_READY__')) {
				throw new Error('Shell startup probe failed');
			}
		}

		if (this.options.initCommand) {
			await this.run(this.options.initCommand, { timeoutMs: this.options.runTimeoutMs });
		}

		this.log('init: ready');
		return this;
	}

	async run(command: string, opts: { timeoutMs?: number } = {}): Promise<ShellRunResult> {
		if (!this.emulator) throw new Error('Shell not initialized. Call init first.');
		if (!command.trim()) return { stdout: '', stderr: '', exitCode: 0, raw: '' };

		const normalizedCommand = command.trim();
		const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : this.options.runTimeoutMs;
		const id = this.makeId();
		const startMarker = `__86V_START_${id}__`;
		const endMarker = `__86V_END_${id}__`;

		const wrapped = [
			`printf '\n${startMarker}\n'`,
			`{ ${normalizedCommand}; } 2>&1`,
			'__ec=$?',
			`printf '\n${endMarker}:%s\n' "$__ec"`
		].join('; ');

		this.log('run: command queued', { command: normalizedCommand, timeoutMs });

		return await new Promise<ShellRunResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRuns.delete(id);
				reject(new Error(`Command timed out after ${timeoutMs} ms: ${normalizedCommand}`));
			}, timeoutMs);

			this.pendingRuns.set(id, {
				id,
				command: normalizedCommand,
				startMarker,
				endMarker,
				timer,
				resolve,
				reject
			});

			this.sendLine(wrapped);
		});
	}

	async readFile(vmPath: string): Promise<Uint8Array> {
		if (!this.emulator) throw new Error('Shell not initialized');
		this.assertSafePath(vmPath);
		return await this.emulator.read_file(vmPath);
	}

	private attachSerialListeners(): void {
		if (!this.emulator) return;
		const outputListener = (byte: number) => {
			const ch = String.fromCharCode(byte);
			this.serialBuffer += ch;
			this.bootBuffer += ch;
			this.processPendingRuns();
		};

		this.emulator.add_listener(BUS_OUTPUT, outputListener);
		this.emulator.add_listener(BUS_OUTPUT_CUSTOM_COMMAND, () => {
			/* noop for now */
		});
	}

	private waitForEmulatorLoaded(): Promise<void> {
		if (!this.emulator) return Promise.reject(new Error('Shell not initialized'));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Timed out waiting for emulator-loaded')), this.options.bootTimeoutMs);
			this.emulator?.bus.register('emulator-loaded', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private waitForPrompt(): Promise<void> {
		const started = Date.now();
		return new Promise((resolve, reject) => {
			const tick = () => {
				if (Date.now() - started > this.options.bootTimeoutMs) {
					reject(new Error('Timed out waiting for shell prompt'));
					return;
				}

				if (this.options.promptRegex.test(this.bootBuffer)) {
					resolve();
					return;
				}

				try {
					this.sendByte(12);
				} catch {
					/* ignore */
				}

				setTimeout(tick, 200);
			};

			tick();
		});
	}

	private processPendingRuns(): void {
		if (!this.pendingRuns.size) return;

		for (const [id, pending] of this.pendingRuns.entries()) {
			const startRegex = new RegExp(`(?:\\r?\\n)${this.escapeRegExp(pending.startMarker)}\\r?\\n`);
			const startMatch = startRegex.exec(this.serialBuffer);
			if (!startMatch) continue;

			const payloadStart = startMatch.index + startMatch[0].length;
			const afterStart = this.serialBuffer.slice(payloadStart);
			const endRegex = new RegExp(`(?:\\r?\\n)${this.escapeRegExp(pending.endMarker)}:(\\d+)\\r?\\n?`);
			const endMatch = endRegex.exec(afterStart);
			if (!endMatch) continue;

			const exitCode = Number(endMatch[1]);
			const endLineStart = payloadStart + endMatch.index;
			const raw = this.serialBuffer.slice(payloadStart, endLineStart);

			clearTimeout(pending.timer);
			this.pendingRuns.delete(id);

			const stdout = raw
				.replace(/\r/g, '')
				.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
				.replace(/^\n+/, '')
				.replace(/\n+$/, '');

			pending.resolve({ stdout, stderr: '', exitCode, raw });
			const consumedUntil = payloadStart + endMatch.index + endMatch[0].length;
			this.serialBuffer = this.serialBuffer.slice(consumedUntil);
		}
	}

	private sendLine(line: string): void {
		this.log('[serial] _sendLine', { line });
		this.sendString(line);
		this.sendByte(13);
	}

	private sendString(str: string): void {
		const bytes = new TextEncoder().encode(str);
		for (const byte of bytes) this.sendByte(byte);
	}

	private sendByte(byte: number): void {
		if (!this.emulator) throw new Error('Shell not initialized');
		this.emulator.bus.send(BUS_INPUT, byte);
	}

	private makeId(): string {
		const arr = new Uint32Array(2);
		crypto.getRandomValues(arr);
		return `${Date.now().toString(36)}_${arr[0].toString(36)}${arr[1].toString(36)}`;
	}

	private assertSafePath(path: string): void {
		if (!path.startsWith('/') || path.includes('..') || path.includes('\0')) {
			throw new Error(`Unsafe VM path: ${path}`);
		}
	}

	private escapeRegExp(text: string): string {
		return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
