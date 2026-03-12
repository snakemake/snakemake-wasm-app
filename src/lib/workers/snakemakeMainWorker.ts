// @ts-nocheck

import { loadPyodide } from "pyodide";
import pyodidePackage from "pyodide/package.json";
import pyodideLock from "pyodide/pyodide-lock.json";

let pyodideIndexUrl = "/pyodide/";
const PYODIDE_CDN_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${pyodidePackage.version}/full/`;
const MICROPIP_WHEEL_NAME = pyodideLock?.packages?.micropip?.file_name;

let pyodidePromise = null;
let runtimeReady = false;
let runtimeInitPromise = null;
let cancelled = false;
let shellRunCounter = 0;
const pendingShellRuns = new Map();

const postLog = (text) => {
  postMessage({ type: "log", text: String(text) });
};

const postProgress = (payload) => {
  postMessage({ type: "progress", payload });
};

function runShellCommandViaHost(command, outputPaths = [], timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const requestId = `shell_${Date.now()}_${shellRunCounter++}`;
    let outputPathValues = outputPaths;
    if (!Array.isArray(outputPathValues) && outputPathValues && typeof outputPathValues.toJs === "function") {
      try {
        outputPathValues = outputPathValues.toJs();
      } catch {
        outputPathValues = [];
      }
    }

    const normalizedOutputPaths = Array.isArray(outputPathValues)
      ? outputPathValues
          .map((path) => String(path ?? "").trim())
          .filter((path) => path.length > 0 && !path.includes("..") && !path.startsWith("/"))
      : [];
    const timer = setTimeout(() => {
      pendingShellRuns.delete(requestId);
      reject(new Error(`Shell command timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    pendingShellRuns.set(requestId, { resolve, reject, timer });
    postMessage({
      type: "shell-run-request",
      requestId,
      command,
      outputPaths: normalizedOutputPaths,
      timeoutMs,
    });
  });
}

globalThis.runSnakemakeWasmShellCommand = async (command, outputPaths) => {
  return runShellCommandViaHost(String(command ?? ""), outputPaths);
};

async function getPyodide() {
  if (!pyodidePromise) {
    postLog(`Loading Pyodide from npm package artifacts at ${pyodideIndexUrl}`);
    postLog(`Using Pyodide package CDN base ${PYODIDE_CDN_BASE_URL}`);
    pyodidePromise = (async () => {
      const pyodide = await loadPyodide({
        indexURL: pyodideIndexUrl,
        packageBaseUrl: PYODIDE_CDN_BASE_URL,
      });
      pyodide.setStdout({
        batched: (line) => postLog(line),
      });
      pyodide.setStderr({
        batched: (line) => postLog(line),
      });
      postLog(`Pyodide JS version: ${pyodide.version}`);
      return pyodide;
    })();
  }
  return pyodidePromise;
}

async function ensureRuntime(pyodide, wheels) {
  if (runtimeReady) {
    return;
  }

  if (runtimeInitPromise) {
    await runtimeInitPromise;
    return;
  }

  runtimeInitPromise = (async () => {
    postProgress({ stage: "runtime", status: "starting" });
    postLog("Loading micropip");
    if (MICROPIP_WHEEL_NAME) {
      await pyodide.loadPackage(`${PYODIDE_CDN_BASE_URL}${MICROPIP_WHEEL_NAME}`);
    } else {
      await pyodide.loadPackage("micropip");
    }
    postLog("Bootstrapping micropip");
    await pyodide.runPythonAsync(`
import micropip
await micropip.install("micropip")
`);

    if (Array.isArray(wheels) && wheels.length > 0) {
      postLog(`Installing local wheels (${wheels.length})`);
      pyodide.globals.set("_worker_wheels", wheels);
      await pyodide.runPythonAsync(`
import micropip
await micropip.install(list(_worker_wheels))
del _worker_wheels
`);
      postLog("Local wheel installation complete");
    } else {
      postLog("No local wheels provided");
    }

    postLog("Installing snakemake (with dependencies)");
    await pyodide.runPythonAsync(`
import micropip
await micropip.install("snakemake", deps=True)
`);
    postLog("snakemake installation complete");

    runtimeReady = true;
    postProgress({ stage: "runtime", status: "ready" });
  })();

  try {
    await runtimeInitPromise;
  } finally {
    runtimeInitPromise = null;
  }
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) {
    return [];
  }

  return files
    .map((file) => {
      if (!file || typeof file !== "object") {
        return null;
      }
      const path = typeof file.path === "string" ? file.path.trim() : "";
      const encoding = file.encoding === "base64" ? "base64" : "utf-8";
      const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
      if (!path) {
        return null;
      }
      if (path.startsWith("/") || path.includes("..")) {
        throw new Error(`Invalid file path: ${path}`);
      }
      return { path, encoding, content };
    })
    .filter(Boolean);
}

async function runWorkflow(pyodide, snakefileText, files, configYaml) {
  pyodide.globals.set("_snakefile_text", snakefileText);
  pyodide.globals.set("_worker_input_files", files);
  pyodide.globals.set("_workflow_config_yaml", configYaml);

  const resultJson = await pyodide.runPythonAsync(`
import asyncio
import json
import sys
from pathlib import Path

# Clean up possibly partially initialized modules from prior failed runs.
sys.modules.pop("snakemake.api", None)
sys.modules.pop("snakemake.workflow", None)
sys.modules.pop("snakemake.common", None)

from snakemake.api import SnakemakeApi
import snakemake.common
import snakemake.workflow
from snakemake.scheduling.greedy import SchedulerSettings as GreedySchedulerSettings
from snakemake.settings.types import (
    ConfigSettings,
    DAGSettings,
    DeploymentSettings,
    ExecutionSettings,
    OutputSettings,
    ResourceSettings,
  SchedulingSettings,
  StorageSettings,
  WorkflowSettings,
)

from snakemake_executor_plugin_wasm import ExecutorSettings
import yaml


def _as_python(value):
  try:
    return value.to_py()
  except Exception:
    return value


workflow_config_yaml = _as_python(_workflow_config_yaml)
worker_input_files = _as_python(_worker_input_files)
if worker_input_files is None:
  worker_input_files = []

print("Python version:", sys.version)

_orig_common_async_run = snakemake.common.async_run
_orig_workflow_async_run = snakemake.workflow.Workflow.async_run


def _pyodide_async_run(coro):
    if sys.platform == "emscripten":
        loop = asyncio.get_running_loop()
        return loop.run_until_complete(coro)
    return _orig_common_async_run(coro)


def _pyodide_workflow_async_run(self, coro):
    if sys.platform == "emscripten":
        loop = asyncio.get_running_loop()
        return loop.run_until_complete(coro)
    return _orig_workflow_async_run(self, coro)


snakemake.common.async_run = _pyodide_async_run
snakemake.workflow.Workflow.async_run = _pyodide_workflow_async_run

for file_spec in worker_input_files:
  file_spec = _as_python(file_spec)
  if not isinstance(file_spec, dict):
    continue
  file_path = Path(str(file_spec.get("path", "")))
  file_content = str(file_spec.get("content", ""))
  file_encoding = str(file_spec.get("encoding", "utf-8"))
  if not str(file_path):
    continue
  file_path.parent.mkdir(parents=True, exist_ok=True)
  if file_encoding == "base64":
    import base64

    file_path.write_bytes(base64.b64decode(file_content))
  else:
    file_path.write_text(file_content, encoding="utf-8")
  print("Wrote file:", file_path.as_posix())

Path("Snakefile").write_text(_snakefile_text, encoding="utf-8")
print("Snakefile written")
config_yaml_text = str(workflow_config_yaml)
config_yaml_has_values = any(
  line.strip() and not line.lstrip().startswith("#")
  for line in config_yaml_text.splitlines()
)
if not config_yaml_has_values:
  config_yaml_text = "{}"
Path("config.yaml").write_text(config_yaml_text, encoding="utf-8")
print("config.yaml written")

workflow_config = yaml.safe_load(config_yaml_text) or {}
if not isinstance(workflow_config, dict):
  raise ValueError("config.yaml must contain a YAML mapping/object at the top level")

if workflow_config.get("trim") is None:
  workflow_config["trim"] = {}
if workflow_config.get("kmer") is None:
  workflow_config["kmer"] = {}

status = {
    "python": sys.version,
}
updated_files = []

with SnakemakeApi(
    OutputSettings(
        verbose=True,
        show_failed_logs=True,
    )
) as api:
    workflow_api = api.workflow(
        resource_settings=ResourceSettings(cores=1, nodes=1),
      config_settings=ConfigSettings(
        config=workflow_config,
        configfiles=[Path("config.yaml")],
      ),
        storage_settings=StorageSettings(),
        workflow_settings=WorkflowSettings(),
        deployment_settings=DeploymentSettings(),
        snakefile=Path("Snakefile"),
        workdir=Path("."),
    )

    dag_api = workflow_api.dag(
        dag_settings=DAGSettings(),
    )

    ok = dag_api.execute_workflow(
        executor="wasm",
        execution_settings=ExecutionSettings(),
      scheduling_settings=SchedulingSettings(scheduler="greedy"),
      scheduler_settings=GreedySchedulerSettings(
        greediness=1.0,
        omit_prioritize_by_temp_and_input=False,
      ),
      greedy_scheduler_settings=GreedySchedulerSettings(
        greediness=1.0,
        omit_prioritize_by_temp_and_input=False,
      ),
        executor_settings=ExecutorSettings(),
        updated_files=updated_files,
    )

    status["run_ok"] = ok
status["written_files"] = [
  str(Path(str(file_spec.get("path", ""))))
  for file_spec in worker_input_files
  if isinstance(file_spec, dict) and file_spec.get("path")
]

output_files = []
for file_path_str in updated_files:
    file_path = Path(file_path_str)
    if not file_path.exists() or not file_path.is_file():
        continue
    raw = file_path.read_bytes()
    try:
        text = raw.decode("utf-8")
        output_files.append(
            {
                "path": file_path.as_posix(),
                "encoding": "utf-8",
                "text": text,
            }
        )
    except UnicodeDecodeError:
        import base64

        output_files.append(
            {
                "path": file_path.as_posix(),
                "encoding": "base64",
                "base64": base64.b64encode(raw).decode("ascii"),
            }
        )

status["output_files"] = output_files
status["updated_files"] = [str(Path(path)) for path in updated_files]
status["config_file"] = "config.yaml"

json.dumps(status)
`);

  pyodide.globals.delete("_snakefile_text");
  pyodide.globals.delete("_worker_input_files");
  pyodide.globals.delete("_workflow_config_yaml");
  return JSON.parse(resultJson);
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (typeof msg.pyodideIndexUrl === "string" && msg.pyodideIndexUrl.length > 0) {
    pyodideIndexUrl = msg.pyodideIndexUrl.endsWith("/") ? msg.pyodideIndexUrl : `${msg.pyodideIndexUrl}/`;
  }

  if (msg.type === "init") {
    const wheels = Array.isArray(msg.wheels) ? msg.wheels : [];

    try {
      const pyodide = await getPyodide();
      await ensureRuntime(pyodide, wheels);
      postMessage({ type: "init-ready" });
    } catch (err) {
      const errorText = err && err.message ? err.message : String(err);
      postLog(`Runtime init failed: ${errorText}`);
      postMessage({ type: "init-error", error: errorText });
    }
    return;
  }

  if (msg.type === "shell-run-response") {
    const requestId = String(msg.requestId || "");
    const pending = pendingShellRuns.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    pendingShellRuns.delete(requestId);

    if (msg.ok) {
      pending.resolve({
        stdout: String(msg.stdout ?? ""),
        stderr: String(msg.stderr ?? ""),
        exitCode: Number.isFinite(msg.exitCode) ? msg.exitCode : 0,
        files: Array.isArray(msg.files) ? msg.files : [],
      });
    } else {
      pending.reject(new Error(String(msg.error ?? "Shell command failed")));
    }
    return;
  }

  if (msg.type === "cancel") {
    cancelled = true;
    postLog("Cancel requested");
    postProgress({ stage: "cancel", status: "requested" });

    for (const [requestId, pending] of pendingShellRuns.entries()) {
      clearTimeout(pending.timer);
      pendingShellRuns.delete(requestId);
      pending.reject(new Error("Cancelled by user"));
    }

    return;
  }

  if (msg.type !== "run") {
    postMessage({ type: "error", error: `Unsupported message type: ${String(msg.type)}` });
    return;
  }

  const snakefile = typeof msg.snakefile === "string" ? msg.snakefile : "";
  const configYaml = typeof msg.configYaml === "string" ? msg.configYaml : "";
  const files = normalizeFiles(msg.files);
  const wheels = Array.isArray(msg.wheels) ? msg.wheels : [];

  cancelled = false;

  try {
    postProgress({ stage: "run", status: "starting" });
    const pyodide = await getPyodide();

    if (cancelled) {
      throw new Error("Run cancelled before runtime initialization");
    }

    await ensureRuntime(pyodide, wheels);

    if (cancelled) {
      throw new Error("Run cancelled before workflow execution");
    }

    postLog("Starting Snakemake workflow");
    postProgress({ stage: "workflow", status: "running" });

    const payload = await runWorkflow(pyodide, snakefile, files, configYaml);

    postLog("Workflow finished");
    postProgress({ stage: "workflow", status: "finished" });
    postMessage({ type: "result", payload });
  } catch (err) {
    const errorText = err && err.message ? err.message : String(err);
    postLog(`Workflow failed: ${errorText}`);
    postMessage({ type: "error", error: errorText });
  }
};
