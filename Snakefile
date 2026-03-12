rule all:
    input:
        "hello.txt"
        
rule hello:
    output:
        "hello.txt"
    shell:
        "echo 'Snakemake ❤️ Wasm'  > {output}"