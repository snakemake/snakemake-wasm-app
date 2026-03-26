<script lang="ts">
	export let envVarsInput: string;
	export let onEnvVarsInputChange: (value: string) => void;
	export let runtimeFilesInput: string;
	export let onRuntimeFilesInputChange: (value: string) => void;
</script>

<div class="space-y-3 border border-slate-200 bg-white p-2">
    <div>
		<label for="runtime-files-input" class="block text-xs font-medium text-slate-700">Runtime File URLs</label>
		<p class="mt-1 text-xs text-slate-500">One URL per line. Files are fetched and queued before each run.</p>
		<textarea
			id="runtime-files-input"
			class="mt-2 h-28 w-full resize-y border border-slate-300 p-2 text-xs font-mono"
			placeholder="https://example.com/data/sample.fastq"
			bind:value={runtimeFilesInput}
			on:input={(e) => {
				const target = e.target as HTMLTextAreaElement | null;
				if (target) {
					onRuntimeFilesInputChange(target.value);
				}
			}}
		></textarea>
	</div>
	<div>
		<label for="envvars-input" class="block text-xs font-medium text-slate-700">Environment Variables</label>
		<p class="mt-1 text-xs text-slate-500">One per line as <code>KEY=VALUE</code>. Example: <code>TEST_TOKEN=abc123</code></p>
		<textarea
			id="envvars-input"
			class="mt-2 h-32 w-full resize-y border border-slate-300 p-2 text-xs font-mono"
			placeholder="TEST_TOKEN=..."
			bind:value={envVarsInput}
			on:input={(e) => {
				const target = e.target as HTMLTextAreaElement | null;
				if (target) {
					onEnvVarsInputChange(target.value);
				}
			}}
		></textarea>
	</div>

	
</div>
