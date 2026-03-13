<script lang="ts">
	import { tick } from 'svelte';
	import logoUrl from '$lib/assets/favicon.svg';

	let {
		title,
		onTitleChange
	}: {
		title: string;
		onTitleChange: (nextTitle: string) => void;
	} = $props();

	const TITLE_PLACEHOLDER = 'click to add title';
	let isEditing = $state(false);
	let draftTitle = $state('');
	let titleInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (!isEditing) {
		draftTitle = title ?? '';
		}
	});

	const beginEdit = async () => {
		isEditing = true;
		draftTitle = title ?? '';
		await tick();
		titleInput?.focus();
		titleInput?.select();
	};

	const cancelEdit = () => {
		isEditing = false;
		draftTitle = title ?? '';
	};

	const commitEdit = () => {
		isEditing = false;
		onTitleChange(draftTitle.trim());
	};

	const handleEditorKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			commitEdit();
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			cancelEdit();
		}
	};
</script>

<nav class="w-full border-b border-slate-200 bg-slate-50 px-4 py-2">
	<div class="mx-auto flex max-w-[1800px] items-center gap-3">
		<div class="flex items-center gap-2">
			<img src={logoUrl} alt="Snakemake logo" class="h-6 w-6" />
			<span class="text-sm font-semibold text-slate-900">Snakemake-Wasm</span>
		</div>

		{#if isEditing}
			<input
				type="text"
				bind:this={titleInput}
				bind:value={draftTitle}
				onblur={commitEdit}
				onkeydown={handleEditorKeydown}
				class="min-w-0 flex-1 border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
				placeholder={TITLE_PLACEHOLDER}
			/>
		{:else}
			<button
				type="button"
				onclick={beginEdit}
				class="min-w-0 flex-1 truncate border border-transparent px-2 py-1 text-left text-sm hover:border-slate-200"
			>
				<span class={title ? 'text-slate-900' : 'text-slate-500'}>{title || TITLE_PLACEHOLDER}</span>
			</button>
		{/if}
		<a href="https://github.com/snakemake/snakemake-wasm-app" target="_blank" rel="noopener noreferrer" class="text-slate-500 hover:text-slate-900 text-sm">
			GitHub
		</a>
	</div>
</nav>