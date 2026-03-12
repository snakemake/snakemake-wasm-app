export const RUNTIME_WHEELS = [
  'wheels/immutables-0.21-cp313-cp313-pyodide_2025_0_wasm32.whl',
  'wheels/connection_pool-0.0.3-py3-none-any.whl',
  'wheels/psutil-7.2.2-py3-none-any.whl',
  'wheels/snakemake_executor_plugin_wasm-0.1.0-py3-none-any.whl'
];

export const DEFAULT_CONFIG = `message: "Snakemake ❤️ Wasm"`;

export const FALLBACK_SNAKEFILE = String.raw`rule all:
    input:
        "hello.txt"

rule hello:
    output:
        "hello.txt"
    params: 
        msg=config.get("message")
    shell:
        "echo '{params.msg}' > {output}"`;
