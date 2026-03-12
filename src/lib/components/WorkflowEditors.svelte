<script lang="ts">
	let {
		snakefile,
		configYaml,
		onSnakefileChange,
		onConfigChange
	}: {
		snakefile: string;
		configYaml: string;
		onSnakefileChange: (next: string) => void;
		onConfigChange: (next: string) => void;
	} = $props();
</script>

<section class="space-y-2">
	<label for="snakefile" class="text-xl font-semibold">Workflow (Snakefile)</label>
	<textarea
		id="snakefile"
		rows="14"
		class="w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-sm text-slate-900 shadow-sm"
		value={snakefile}
		oninput={(event) => onSnakefileChange((event.currentTarget as HTMLTextAreaElement).value)}
	></textarea>
</section>

<section class="pt-3 space-y-2">
	<label for="configInput" class="text-base font-semibold">Config (YAML)</label>
	<textarea
		id="configInput"
		rows="8"
		class="w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-sm text-slate-900 shadow-sm"
		value={configYaml}
		oninput={(event) => onConfigChange((event.currentTarget as HTMLTextAreaElement).value)}
	></textarea>
</section>
