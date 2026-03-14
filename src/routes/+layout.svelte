<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	const appTitle = 'Snakemake WASM App';
	const appDescription =
		'Run Snakemake workflows directly in the browser with an interactive IDE powered by Pyodide, web workers, and a WASM Linux runtime.';
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="description" content={appDescription} />

	<meta property="og:type" content="website" />
	<meta property="og:title" content={appTitle} />
	<meta property="og:description" content={appDescription} />
	<meta property="og:image" content={favicon} />
	<meta property="og:image:alt" content="Snakemake WASM App logo" />

	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={appTitle} />
	<meta name="twitter:description" content={appDescription} />
	<meta name="twitter:image" content={favicon} />
	<meta name="twitter:image:alt" content="Snakemake WASM App logo" />
</svelte:head>
{@render children()}
