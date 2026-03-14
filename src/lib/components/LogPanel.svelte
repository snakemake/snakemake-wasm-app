<script lang="ts">
	import { tick } from 'svelte';

	let {
		logs,
		terminalRef
	}: {
		logs: string[];
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

<div class="flex h-full min-h-0 flex-col">
	<textarea
		bind:this={logElement}
		readonly
		spellcheck="false"
		class="flex-1 min-h-0 overflow-auto border border-slate-300 bg-slate-950 p-2 text-xs text-slate-100 select-text"
		value={logs.join('\n')}
	></textarea>
</div>
