<script lang="ts">
	let {
		runDisabled,
		onRun,
		onCancel,
		onClear,
		workerCount,
		workerCountMax,
		onWorkerCountChange
	}: {
		runDisabled: boolean;
		onRun: () => Promise<void>;
		onCancel: () => void;
		onClear: () => void;
		workerCount: number;
		workerCountMax: number;
		onWorkerCountChange: (value: string) => void;
	} = $props();
</script>

<section class="pt-1 flex w-full flex-wrap items-center justify-between gap-2">
	<div class="flex flex-wrap gap-1">
		<button
			type="button"
			disabled={runDisabled}
			onclick={onRun}
			class="inline-flex items-center border border-green-800 bg-green-700 px-2 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-slate-400"
		>
			Run Workflow
		</button>
		<button
			type="button"
			onclick={onCancel}
			class="inline-flex items-center border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50"
		>
			Cancel
		</button>
		<button
			type="button"
			onclick={onClear}
			class="inline-flex items-center border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50"
		>
			Clear Log
		</button>
	</div>

	<div class="flex items-center gap-2">
		<label for="workers-input" class="text-xs font-medium text-slate-700">Workers</label>
		<input
			id="workers-input"
			type="number"
			min="1"
			max={workerCountMax}
			value={workerCount}
			oninput={(event) => onWorkerCountChange((event.currentTarget as HTMLInputElement).value)}
			class="w-16 border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
		/>
	</div>
</section>
