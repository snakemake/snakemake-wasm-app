<script lang="ts">
	let {
		runDisabled,
		onRun,
		onCancel,
		onClear
	}: {
		runDisabled: boolean;
		onRun: () => Promise<void>;
		onCancel: () => void;
		onClear: () => void;
	} = $props();
</script>

<section class="pt-1 flex flex-wrap gap-1">
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
</section>
