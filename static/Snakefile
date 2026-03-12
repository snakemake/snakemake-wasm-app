rule all:
    input:
        "hello.txt"

rule hello:
    output:
        "hello.txt"
    params: 
        msg=config.get("message")
    shell:
        "echo '{params.msg}' > {output}"