<script lang="ts">
	import { FileIcon, FolderIcon } from '@lucide/svelte';
	import { TreeView, createTreeViewCollection } from '@skeletonlabs/skeleton-svelte';
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

	interface ResolvedOutputFile {
		file: OutputFilePayload;
		href: string;
		label: string;
		downloadName: string;
		sizeLabel: string;
	}

	interface OutputTreeNode {
		id: string;
		name: string;
		children?: OutputTreeNode[];
		entry?: ResolvedOutputFile;
	}

	const resolvedOutputs = $derived.by((): ResolvedOutputFile[] => {
		const entries: ResolvedOutputFile[] = [];
		for (const file of outputs) {
			const resolved = toDownloadUrl(file);
			if (!resolved) continue;
			entries.push({
				file,
				href: resolved.href,
				label: resolved.label,
				downloadName: getDownloadFileName(resolved.label),
				sizeLabel: formatSize(getOutputSizeBytes(file))
			});
		}
		return entries;
	});

	const outputTreeNodes = $derived.by((): OutputTreeNode[] => {
		const root: OutputTreeNode = { id: 'root', name: '', children: [] };
		const byId = new Map<string, OutputTreeNode>([['root', root]]);

		const getOrCreateFolderNode = (folderId: string, folderName: string, parent: OutputTreeNode): OutputTreeNode => {
			const existing = byId.get(folderId);
			if (existing) return existing;

			const node: OutputTreeNode = { id: folderId, name: folderName, children: [] };
			byId.set(folderId, node);
			if (!parent.children) parent.children = [];
			parent.children.push(node);
			return node;
		};

		for (const entry of resolvedOutputs) {
			const segments = entry.label.split('/').filter(Boolean);
			let parent = root;

			for (let index = 0; index < segments.length - 1; index += 1) {
				const segment = segments[index];
				const folderId = parent.id === 'root' ? segment : `${parent.id}/${segment}`;
				parent = getOrCreateFolderNode(folderId, segment, parent);
			}

			const fileName = segments.at(-1) ?? entry.label;
			if (!parent.children) parent.children = [];
			parent.children.push({
				id: entry.label,
				name: fileName,
				entry
			});
		}

		const sortNodes = (nodes: OutputTreeNode[]): void => {
			nodes.sort((left, right) => {
				const leftIsFolder = Array.isArray(left.children) && left.children.length > 0;
				const rightIsFolder = Array.isArray(right.children) && right.children.length > 0;
				if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1;
				return left.name.localeCompare(right.name);
			});

			for (const node of nodes) {
				if (node.children?.length) {
					sortNodes(node.children);
				}
			}
		};

		sortNodes(root.children ?? []);
		return root.children ?? [];
	});

	const collection = $derived(
		createTreeViewCollection<OutputTreeNode>({
			nodeToValue: (node) => node.id,
			nodeToString: (node) => node.name,
			rootNode: {
				id: 'root',
				name: '',
				children: outputTreeNodes
			}
		})
	);
</script>

<section class="space-y-2">
	{#if outputs.length === 0}
		<div class=" text-center bg-slate-50 px-2 py-4 text-xs text-slate-500">No workflow outputs yet.</div>
	{:else}
		<TreeView {collection} defaultExpandedValue={['results', 'logs', 'benchmarks']} >
			<TreeView.Tree class="w-full">
				{#each collection.rootNode.children || [] as node, index (node.id)}
					{@render treeNode(node, [index])}
				{/each}
			</TreeView.Tree>
		</TreeView>
	{/if}
</section>

{#snippet treeNode(node: OutputTreeNode, indexPath: number[])}
	<TreeView.NodeProvider value={{ node, indexPath }}>
		{#if node.children && node.children.length > 0}
			<TreeView.Branch>
				<TreeView.BranchControl
					class="rounded-sm data-[selected]:bg-transparent data-[selected]:outline data-[selected]:outline-1 data-[selected]:outline-slate-300 data-[selected]:text-green-700"
				>
					<TreeView.BranchIndicator />
					<TreeView.BranchText>
						<FolderIcon class="size-4" />
						{node.name}
					</TreeView.BranchText>
				</TreeView.BranchControl>
				<TreeView.BranchContent>
					<TreeView.BranchIndentGuide />
					{#each node.children as childNode, childIndex (childNode.id)}
						{@render treeNode(childNode, [...indexPath, childIndex])}
					{/each}
				</TreeView.BranchContent>
			</TreeView.Branch>
		{:else}
			{@const entry = node.entry}
			{#if entry}
				<TreeView.Item
					class="rounded-sm data-[selected]:bg-transparent data-[selected]:outline data-[selected]:outline-1 data-[selected]:outline-slate-300"
				>
					<div class="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-700">
						<FileIcon class="size-4 shrink-0" />
						<a
							href={entry.href}
							target="_blank"
							rel="noopener noreferrer"
							onpointerdown={(event) => event.stopPropagation()}
							onmousedown={(event) => event.stopPropagation()}
							onclick={(event) => event.stopPropagation()}
							class="min-w-0 flex-1 truncate text-green-700 hover:underline"
						>
							{node.name}
						</a>
						<p class="text-slate-500">{entry.sizeLabel}</p>
						<a
							href={entry.href}
							download={entry.downloadName}
							onpointerdown={(event) => event.stopPropagation()}
							onmousedown={(event) => event.stopPropagation()}
							onclick={(event) => event.stopPropagation()}
							class="border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
						>
							Download
						</a>
					</div>
				</TreeView.Item>
			{/if}
		{/if}
	</TreeView.NodeProvider>
{/snippet}
