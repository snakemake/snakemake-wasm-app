<script lang="ts">
	export interface RuntimeFileItem {
		path: string;
		sizeBytes: number;
	}

	let {
		files,
		onFilePick,
		onRemove
	}: {
		files: RuntimeFileItem[];
		onFilePick: (files: FileList | null) => Promise<void> | void;
		onRemove: (path: string) => void;
	} = $props();

	let uploadInput = $state<HTMLInputElement | null>(null);

	const openUploadPicker = () => {
		uploadInput?.click();
	};

	const formatSize = (bytes: number): string => {
		if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};
</script>

<div class="flex items-center justify-between gap-2 border border-slate-200 px-3 py-2">
	

	{#if files.length > 0}
		<div class="flex-1 max-h-28 overflow-auto ">
			<div class="flex flex-wrap gap-1">
				{#each files as file}
					<div class="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 text-xs text-slate-700">
						<p class="max-w-44 truncate">{file.path}</p>
						<p class="text-slate-500">{formatSize(file.sizeBytes)}</p>
						<button
							type="button"
							onclick={() => onRemove(file.path)}
							class="px-1 text-xs text-slate-400 hover:text-slate-700"
							aria-label={`Remove runtime file ${file.path}`}
						>
							x
						</button>
					</div>
				{/each}
			</div>
		</div>

	{:else}
		<div class="flex-1 text-center text-xs text-slate-500">No runtime files added.</div>
	{/if}
    <div class="flex items-center justify-between gap-2">
		<button
			type="button"
			onclick={openUploadPicker}
			class="border border-slate-200 px-2 py-1 text-xs text-slate-600"
			aria-label="Add runtime files"
		>
			+
		</button>
		<input
			bind:this={uploadInput}
			type="file"
			multiple
			class="hidden"
			onchange={() => onFilePick(uploadInput?.files ?? null)}
		/>
	</div>
</div>
