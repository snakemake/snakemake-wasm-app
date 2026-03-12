<script lang="ts">
	import type { OutputFilePayload } from '$lib/types/workflow';

	let {
		outputs,
		toDownloadUrl
	}: {
		outputs: OutputFilePayload[];
		toDownloadUrl: (file: OutputFilePayload) => { href: string; label: string } | null;
	} = $props();

	const formatSize = (bytes: number): string => {
		if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	const getOutputSizeBytes = (file: OutputFilePayload): number => {
		if (file.encoding === 'base64' && file.base64) {
			const normalized = file.base64.replace(/\s/g, '');
			if (normalized.length === 0) return 0;
			const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
			return Math.floor((normalized.length * 3) / 4) - padding;
		}

		if (file.text) {
			return new TextEncoder().encode(file.text).length;
		}

		return 0;
	};

	const getDownloadFileName = (label: string): string => {
		const normalized = String(label ?? '').trim();
		if (!normalized) return 'download.bin';
		const parts = normalized.split('/').filter(Boolean);
		return parts.at(-1) ?? 'download.bin';
	};
</script>

<section class="space-y-2">
	{#if outputs.length === 0}
		<div class=" text-center bg-slate-50 px-2 py-4 text-xs text-slate-500">No workflow outputs yet.</div>
	{:else}
		<div class="space-y-1">
			{#each outputs as file}
				{@const resolved = toDownloadUrl(file)}
				{@const sizeLabel = formatSize(getOutputSizeBytes(file))}
				{@const downloadName = resolved ? getDownloadFileName(resolved.label) : 'download.bin'}
				{#if resolved}
					<div class="flex items-center gap-2 border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100">
						<p class="min-w-0 flex-1 truncate">{resolved.label}</p>
						<p class="text-slate-500">{sizeLabel}</p>
						<a
							href={resolved.href}
							download={downloadName}
							class="border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
						>
							Download
						</a>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</section>
