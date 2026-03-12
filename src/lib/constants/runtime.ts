export const RUNTIME_WHEELS = [
  'wheels/immutables-0.21-cp313-cp313-pyodide_2025_0_wasm32.whl',
  'wheels/connection_pool-0.0.3-py3-none-any.whl',
  'wheels/psutil-7.2.2-py3-none-any.whl',
  'wheels/snakemake_executor_plugin_wasm-0.1.0-py3-none-any.whl'
];

export const DEFAULT_CONFIG = `samples:
  - mutant
reads_dir: "data"
out_dir: "results"
adapters:
  - "AGATCGGAAGAGC"
  - "CTGTCTCTTATACACATCT"
trim:
  min_length: 50
  min_mean_quality: 20
  trim_trailing_below: 20
kmer:
  k: 5
  top_n: 100
`;

export const FALLBACK_SNAKEFILE = String.raw`rule all:
    input:
        "results/hello.txt"

rule make_hello:
    output:
        "results/hello.txt"
    run:
        from pathlib import Path
        Path(output[0]).parent.mkdir(parents=True, exist_ok=True)
        Path(output[0]).write_text("hello from snakemake in pyodide", encoding="utf-8")
`;
