<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { Compartment, EditorState, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';

	let {
		path,
		value,
		onChange
	}: {
		path: string;
		value: string;
		onChange: (nextValue: string) => void;
	} = $props();

	let containerEl: HTMLDivElement | null = $state(null);
	let editorView: EditorView | null = null;
	const languageCompartment = new Compartment();

	const languageForPath = async (inputPath: string): Promise<Extension> => {
		const normalized = inputPath.trim().toLowerCase();

		if (normalized === 'snakefile' || normalized.endsWith('.py')) {
			const mod = await import('@codemirror/lang-python');
			return mod.python();
		}

		if (normalized.endsWith('.yaml') || normalized.endsWith('.yml')) {
			const mod = await import('@codemirror/lang-yaml');
			return mod.yaml();
		}

		return [];
	};

	const reconfigureLanguage = async (nextPath: string) => {
		if (!editorView) return;
		const extension = await languageForPath(nextPath);
		editorView.dispatch({
			effects: languageCompartment.reconfigure(extension)
		});
	};

	onMount(async () => {
		if (!containerEl) return;

		const initialLanguage = await languageForPath(path);

		editorView = new EditorView({
			parent: containerEl,
			state: EditorState.create({
				doc: value,
				extensions: [
					basicSetup,
					languageCompartment.of(initialLanguage),
					EditorView.domEventHandlers({
						keydown: (event) => {
							event.stopPropagation();
							return false;
						},
						keypress: (event) => {
							event.stopPropagation();
							return false;
						},
						keyup: (event) => {
							event.stopPropagation();
							return false;
						}
					}),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						const nextValue = update.state.doc.toString();
						if (nextValue !== value) onChange(nextValue);
					}),
					EditorView.theme({
						'&': {
							height: '100%'
						},
						'.cm-scroller': {
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
							fontSize: '0.875rem'
						}
					})
				]
			})
		});
	});

	onDestroy(() => {
		editorView?.destroy();
		editorView = null;
	});

	$effect(() => {
		if (!editorView) return;
		const current = editorView.state.doc.toString();
		if (value === current) return;
		editorView.dispatch({
			changes: { from: 0, to: current.length, insert: value }
		});
	});

	$effect(() => {
		if (!editorView) return;
		void reconfigureLanguage(path);
	});
</script>

<div bind:this={containerEl} class="h-full w-full"></div>
