<script lang="ts">
	import { onMount } from 'svelte';
	import { Tabs } from '@skeletonlabs/skeleton-svelte';
	import { File, FileCode, FileBraces, FileText } from '@lucide/svelte';
	import snakemakeLogoUrl from '$lib/assets/snakemake-logo.svg';

	export interface IdeTabItem {
		id: string;
		path: string;
		content: string;
	}

	let {
		tabs,
		activeTabId,
		onSelect,
		onAdd,
		onRename,
		onDelete,
		onContentChange
	}: {
		tabs: IdeTabItem[];
		activeTabId: string;
		onSelect: (id: string) => void;
		onAdd: () => void;
		onRename: (id: string, nextPath: string) => void;
		onDelete: (id: string) => void;
		onContentChange: (id: string, nextContent: string) => void;
	} = $props();

	const tabLabel = (tab: IdeTabItem) => tab.path.trim() || 'untitled';
	const isSnakefileTab = (tab: IdeTabItem) => {
		const label = tabLabel(tab).toLowerCase();
		return label === 'snakefile' || label.endsWith('/snakefile') || label.endsWith('.smk');
	};
	const tabIcon = (tab: IdeTabItem) => {
		const label = tabLabel(tab).toLowerCase();
		if (label.endsWith('.py') || label.endsWith('.r') || label.endsWith('.js') || label.endsWith('.ts')) {
			return FileCode;
		}
		if (label.endsWith('.yaml') || label.endsWith('.yml') || label.endsWith('.json')) {
			return FileBraces;
		}
		if (label.endsWith('.txt') || label.endsWith('.log') || label.endsWith('.md') || label.endsWith('.snakefile')) {
			return FileText;
		}
		return File;
	};
	const activeTab = $derived(tabs.find((tab) => tab.id === activeTabId) ?? null);
	let LazyCodeEditor: any = $state(null);

	onMount(async () => {
		const module = await import('./CodeEditor.svelte');
		LazyCodeEditor = module.default;
	});
</script>

<section class="flex h-full flex-col border border-slate-200">
	{#if tabs.length === 0}
		<div class="flex flex-1 items-center justify-center border-t border-dashed border-slate-300 text-sm text-slate-500">
			No file tabs available.
		</div>
	{:else}

	<Tabs value={activeTabId} onValueChange={(d) => onSelect(d.value)} class="flex flex-1 min-h-0 flex-col">

		<!-- tab bar -->
		<Tabs.List class="flex border-b border-slate-200 overflow-x-auto mb-0 mt-2">

			{#each tabs as tab}
				{@const Icon = tabIcon(tab)}

				<Tabs.Trigger value={tab.id}>
					<span class="inline-flex items-center gap-1.5">
						{#if isSnakefileTab(tab)}
							<img src={snakemakeLogoUrl} alt="Snakefile" class="size-3.5" />
						{:else}
							<Icon class="size-3.5" />
						{/if}
						{tabLabel(tab)}
					</span>
				</Tabs.Trigger>

			{/each}

			<button
				type="button"
				onclick={(e) => {
					e.stopPropagation();
					onAdd();
				}}
				onmousedown={(e) => e.stopPropagation()}
				class="mx-1 px-2 text-sm text-slate-600 hover:text-slate-900 border border-slate-200"
				aria-label="Add file tab"
			>
				+
			</button>

			<Tabs.Indicator />
		</Tabs.List>

		<!-- content area -->
		<div class="flex flex-1 min-h-0 flex-col">

			{#each tabs as tab}

				<Tabs.Content value={tab.id} class="m-0 flex-1 min-h-0">

					<div class="editor-shell">
						{#if tab.id === activeTabId}
							{#if LazyCodeEditor}
								<LazyCodeEditor path={tab.path} value={tab.content} onChange={(nextValue: string) => onContentChange(tab.id, nextValue)} />
							{:else}
								<div class="editor-loading">Loading editor…</div>
							{/if}
						{/if}
					</div>

				</Tabs.Content>

			{/each}

			{#if activeTab}
				<div class="flex justify-between items-center gap-2 border-t border-slate-200 px-3 py-2">
					<input
						type="text"
						value={activeTab.path}
						oninput={(e) => onRename(activeTab.id, (e.currentTarget as HTMLInputElement).value)}
						class="w-72 border border-slate-200 px-2 py-1 text-xs text-slate-700 outline-none"
						spellcheck="false"
						aria-label={`Filename for tab ${tabLabel(activeTab)}`}
					/>

					<button
						type="button"
						onclick={() => onDelete(activeTab.id)}
						class="border border-slate-200 px-2 py-1 text-xs text-slate-600"
						aria-label={`Delete tab ${tabLabel(activeTab)}`}
					>
						Delete
					</button>
				</div>
			{/if}
		</div>

	</Tabs>

	{/if}
</section>

<style>
	.editor-shell {
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		width: 100%;
	}

	.editor-loading {
		display: flex;
		height: 100%;
		width: 100%;
		align-items: center;
		justify-content: center;
		font-size: 0.875rem;
		color: rgb(100 116 139);
	}
</style>