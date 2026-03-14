<script lang="ts">
	import { tick } from 'svelte';

	type LogStats = {
		status: string;
		workerRuntime: string;
		shellPool: number;
		workers: number;
		logs: number;
		outputs: number;
		runtimeFiles: number;
		elapsed: string;
	};

	let {
		logs,
		stats,
		terminalRef
	}: {
		logs: string[];
		stats: LogStats;
		terminalRef: (element: HTMLDivElement | null) => void;
	} = $props();

	$effect(() => {
		terminalRef(null);
	});

	let logElement = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		void (async () => {
			logs;
			await tick();
			if (logElement) {
				logElement.scrollTop = logElement.scrollHeight;
			}
		})();
	});
</script>

<div class="flex gap-2 h-full min-h-0 flex-col">
	<div class="grid grid-cols-2 gap-1 border border-slate-300 bg-slate-100 p-2 text-[11px] text-slate-700 lg:grid-cols-4">
		<div><span class="font-semibold">Status:</span> {stats.status}</div>
		<div><span class="font-semibold">Runtime:</span> {stats.workerRuntime}</div>
		<div><span class="font-semibold">Workers:</span> {stats.workers}</div>
		<div><span class="font-semibold">Shells:</span> {stats.shellPool}</div>
		<div><span class="font-semibold">Elapsed:</span> {stats.elapsed}</div>
		<div><span class="font-semibold">Logs:</span> {stats.logs}</div>
		<div><span class="font-semibold">Outputs:</span> {stats.outputs}</div>
		<div><span class="font-semibold">Inputs:</span> {stats.runtimeFiles}</div>
	</div>
	<textarea
		bind:this={logElement}
		readonly
		spellcheck="false"
		class="flex-1 min-h-0 overflow-auto border border-slate-300 bg-slate-950 p-2 text-xs text-slate-100 select-text"
		value={logs.join('\n')}
	></textarea>
</div>
