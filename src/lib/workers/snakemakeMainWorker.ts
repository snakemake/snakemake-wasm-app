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
let maxParallelJobs = 1;
let shellRunCounter = 0;
let shellSlotCounter = 0;
const workerSessionId = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MAX_CONCURRENT_SHELL_JOBS = 3;
const pendingShellRuns = new Map();
const artifactStore = new Map();
let submittedJobCounter = 0;
const pendingJobQueue = [];
const activeJobs = new Map();
const jobUpdates = [];
let jobUpdateSequence = 0;
const cancelledAsyncJobIds = new Set();
let webRRuntimePromise = null;
let webROutputCapture = null;
const PYODIDE_WORKDIR_PREFIX = "/home/pyodide/";
const WEBR_WORKSPACE_PREFIX = "/workspace/";

function formatWorkerError(error) {
  if (error instanceof Error) {
    const name = String(error.name || "Error");
    const message = String(error.message || "");
    const stack = String(error.stack || "").trim();
    const cause =
      error && typeof error === "object" && "cause" in error
        ? String(error.cause ?? "")
        : "";

    return [
      `${name}: ${message}`.trim(),
      cause ? `Cause: ${cause}` : "",
      stack,
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  return String(error ?? "Unknown error");
}

function bytesToBase64(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let binary = "";
  const chunkSize = 0x8000;
  for (let idx = 0; idx < array.length; idx += chunkSize) {
    const chunk = array.subarray(idx, idx + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64Value) {
  const normalized = String(base64Value ?? "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let idx = 0; idx < binary.length; idx += 1) {
    bytes[idx] = binary.charCodeAt(idx);
  }
  return bytes;
}

function inferMimeTypeFromPath(pathValue) {
  const normalized = String(pathValue ?? "").trim().toLowerCase();
  const extension = normalized.includes(".") ? normalized.slice(normalized.lastIndexOf(".") + 1) : "";

  switch (extension) {
    case "txt":
    case "log":
    case "tsv":
    case "csv":
    case "json":
    case "yaml":
    case "yml":
    case "r":
      return "text/plain;charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function getWebRRuntime() {
  if (!webRRuntimePromise) {
    webRRuntimePromise = (async () => {
      postLog("Initializing webR runtime");
      const webrModule = await import("webr");
      const webR = new webrModule.WebR({
        interactive: false,
      });
      await webR.init();
      postLog("webR runtime ready");
      return webR;
    })();
  }

  return webRRuntimePromise;
}

async function ensureWebRDirectory(webR, absolutePath) {
  const normalized = String(absolutePath ?? "").trim();
  if (!normalized || normalized === "/") return;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    try {
      await webR.FS.mkdir(current);
    } catch {
      // directory may already exist
    }
  }
}

function toWorkspaceRelativePath(pathValue) {
  const rawPath = String(pathValue ?? "").trim();
  if (!rawPath) return null;

  if (rawPath.startsWith(PYODIDE_WORKDIR_PREFIX)) {
    const relative = rawPath.slice(PYODIDE_WORKDIR_PREFIX.length).trim();
    if (!relative || relative.includes("..") || relative.startsWith("/")) {
      return null;
    }
    return relative;
  }

  if (rawPath.startsWith(WEBR_WORKSPACE_PREFIX)) {
    const relative = rawPath.slice(WEBR_WORKSPACE_PREFIX.length).trim();
    if (!relative || relative.includes("..") || relative.startsWith("/")) {
      return null;
    }
    return relative;
  }

  if (rawPath.startsWith("/")) {
    return null;
  }

  if (rawPath.includes("..")) {
    return null;
  }

  return rawPath;
}

function buildWebROutputReadCandidates(pathValue) {
  const rawPath = String(pathValue ?? "").trim();
  if (!rawPath) return [];

  const candidates = [];
  const relativePath = toWorkspaceRelativePath(rawPath);

  if (relativePath) {
    candidates.push({ absPath: `${WEBR_WORKSPACE_PREFIX}${relativePath}`, relativePath });
    candidates.push({ absPath: `${PYODIDE_WORKDIR_PREFIX}${relativePath}`, relativePath });
  }

  if (rawPath.startsWith("/")) {
    candidates.push({ absPath: rawPath, relativePath });
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || !candidate.absPath) continue;
    if (seen.has(candidate.absPath)) continue;
    seen.add(candidate.absPath);
    unique.push(candidate);
  }
  return unique;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWebRFileWithRetries(webR, candidates, maxWaitMs = 3000, intervalMs = 200) {
  const startedAt = Date.now();
  let firstPass = true;

  while (firstPass || Date.now() - startedAt <= maxWaitMs) {
    firstPass = false;
    for (const candidate of candidates) {
      if (!candidate || !candidate.absPath || !candidate.relativePath) {
        continue;
      }

      try {
        const fileBytes = await webR.FS.readFile(candidate.absPath);
        return { candidate, fileBytes };
      } catch {
        // try next candidate
      }
    }

    await sleep(intervalMs);
  }

  return null;
}

globalThis.runSnakemakeWasmRScript = async (scriptSource, options = {}) => {
  let normalizedOptions = options;
  if (normalizedOptions && typeof normalizedOptions === "object" && typeof normalizedOptions.toJs === "function") {
    try {
      normalizedOptions = normalizedOptions.toJs();
    } catch {
      normalizedOptions = {};
    }
  }

  const timeoutMs = Number.isFinite(normalizedOptions?.timeoutMs)
    ? Math.max(1, Math.floor(Number(normalizedOptions.timeoutMs)))
    : 300000;
  const inputPaths = Array.isArray(normalizedOptions?.inputPaths)
    ? normalizedOptions.inputPaths
        .map((path) => String(path ?? "").trim())
        .filter((path) => path.length > 0)
    : [];
  const explicitInputFiles = Array.isArray(normalizedOptions?.inputFiles)
    ? normalizedOptions.inputFiles
        .map((file) => {
          if (!file || typeof file !== "object") {
            return null;
          }
          try {
            return {
              path: normalizeRelativePath(file.path),
              encoding: file.encoding === "base64" ? "base64" : "utf-8",
              content: typeof file.content === "string" ? file.content : String(file.content ?? ""),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  const outputPaths = Array.isArray(normalizedOptions?.outputPaths)
    ? normalizedOptions.outputPaths
        .map((path) => String(path ?? "").trim())
        .filter((path) => path.length > 0)
    : [];

  const inputFilesByPath = new Map();
  for (const file of explicitInputFiles) {
    inputFilesByPath.set(file.path, file);
  }
  for (const pathValue of inputPaths) {
    const relativePath = toWorkspaceRelativePath(pathValue);
    if (!relativePath) {
      continue;
    }
    const path = normalizeRelativePath(relativePath);
    if (inputFilesByPath.has(path)) {
      continue;
    }
    const artifact = artifactStore.get(path);
    if (!artifact) {
      throw new Error(`Missing required input artifact: ${path}`);
    }
    inputFilesByPath.set(path, {
      path: artifact.path,
      encoding: artifact.encoding,
      content: artifact.content,
    });
  }
  const inputFiles = Array.from(inputFilesByPath.values());
  const workspaceDir = "/home/pyodide";
  const scriptPath = `${workspaceDir}/.snakemake_webr_script.R`;
  const webRShimPrelude = [
    "# snakemake-wasm webR prelude",
    "if (requireNamespace('webr', quietly = TRUE)) {",
    "  webr::shim_install()",
    "} else {",
    "  message('webR support package not available; skipping shim_install()')",
    "}",
    "",
  ].join("\n");

  const runPromise = (async () => {
    const webR = await getWebRRuntime();

    await ensureWebRDirectory(webR, workspaceDir);

    for (const inputFile of inputFiles) {
      const relPath = normalizeRelativePath(inputFile.path);
      const absPath = `${workspaceDir}/${relPath}`;
      const parentPath = absPath.includes("/") ? absPath.slice(0, absPath.lastIndexOf("/")) : workspaceDir;
      await ensureWebRDirectory(webR, parentPath);
      const pyodideMirrorPath = `${PYODIDE_WORKDIR_PREFIX}${relPath}`;
      const pyodideMirrorParentPath = pyodideMirrorPath.includes("/")
        ? pyodideMirrorPath.slice(0, pyodideMirrorPath.lastIndexOf("/"))
        : PYODIDE_WORKDIR_PREFIX;
      await ensureWebRDirectory(webR, pyodideMirrorParentPath);
      if (inputFile.encoding === "base64") {
        const bytes = base64ToBytes(String(inputFile.content ?? ""));
        await webR.FS.writeFile(absPath, bytes);
        await webR.FS.writeFile(pyodideMirrorPath, bytes);
      } else {
        const text = String(inputFile.content ?? "");
        const bytes = new TextEncoder().encode(text);
        await webR.FS.writeFile(absPath, bytes);
        await webR.FS.writeFile(pyodideMirrorPath, bytes);
      }
    }

    const scriptWithPrelude = `${webRShimPrelude}${String(scriptSource ?? "")}`;
    await webR.FS.writeFile(scriptPath, new TextEncoder().encode(scriptWithPrelude));

    const escapedWorkspaceDir = workspaceDir.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const escapedScriptPath = scriptPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    webROutputCapture = { stdout: [], stderr: [] };

    try {
      await webR.evalRVoid(`setwd('${escapedWorkspaceDir}')`);
      await webR.evalRVoid(`source('${escapedScriptPath}')`);
    } finally {
      // keep captured output available for return, then clear shared capture
    }

    const captured = webROutputCapture ?? { stdout: [], stderr: [] };
    webROutputCapture = null;

    const files = [];
    for (const outputPath of outputPaths) {
      const candidates = buildWebROutputReadCandidates(outputPath);
      const found = await readWebRFileWithRetries(webR, candidates, 3500, 200);

      if (found) {
        const { candidate, fileBytes } = found;
        let bytes = fileBytes;
        if (bytes && typeof bytes.toJs === "function") {
          bytes = bytes.toJs();
        }

        if (!(bytes instanceof Uint8Array)) {
          try {
            bytes = new Uint8Array(bytes);
          } catch {
            bytes = new TextEncoder().encode(String(bytes ?? ""));
          }
        }

        const mimeType = inferMimeTypeFromPath(candidate.relativePath);
        if (mimeType.startsWith("text/")) {
          files.push({ path: candidate.relativePath, encoding: "utf-8", text: new TextDecoder().decode(bytes) });
        } else {
          files.push({ path: candidate.relativePath, encoding: "base64", base64: bytesToBase64(bytes) });
        }
      } else {
        postLog(
          `[webr] output not found: ${String(outputPath)} candidates=${candidates
            .map((candidate) => candidate.absPath)
            .join(",")}`
        );
      }
    }

    return {
      exitCode: 0,
      stdout: captured.stdout.join("\n"),
      stderr: captured.stderr.join("\n"),
      files,
    };
  })();

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`webR script timed out after ${timeoutMs} ms`)), timeoutMs);
  });

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } catch (error) {
    const formattedError = formatWorkerError(error);
    postLog(`[webr:error] ${formattedError}`);
    const captured = webROutputCapture ?? { stdout: [], stderr: [] };
    webROutputCapture = null;
    return {
      exitCode: 1,
      stdout: captured.stdout.join("\n"),
      stderr: captured.stderr.join("\n"),
      error: formattedError,
      files: [],
    };
  }
};

function normalizeRelativePath(pathValue) {
  const path = String(pathValue ?? "").trim();
  if (!path || path.startsWith("/") || path.includes("..")) {
    throw new Error(`Invalid file path: ${path}`);
  }
  return path;
}

function upsertArtifact(file) {
  if (!file || typeof file !== "object") {
    return;
  }
  const path = normalizeRelativePath(file.path);
  const encoding = file.encoding === "base64" ? "base64" : "utf-8";
  const content = typeof file.content === "string" ? file.content : String(file.content ?? "");
  artifactStore.set(path, {
    path,
    encoding,
    content,
    updatedAt: Date.now(),
  });
}

function seedArtifactStore(snakefileText, files, configYaml) {
  artifactStore.clear();
  upsertArtifact({
    path: "Snakefile",
    encoding: "utf-8",
    content: String(snakefileText ?? ""),
  });
  upsertArtifact({
    path: "config.yaml",
    encoding: "utf-8",
    content: String(configYaml ?? ""),
  });
  if (Array.isArray(files)) {
    for (const file of files) {
      upsertArtifact(file);
    }
  }
}

function buildInputFilesFromArtifactStore() {
  const files = [];
  for (const [path, file] of artifactStore.entries()) {
    if (path === "Snakefile" || path === "config.yaml") {
      continue;
    }
    files.push({ path: file.path, encoding: file.encoding, content: file.content });
  }
  return files;
}

function syncOutputArtifacts(outputFiles) {
  if (!Array.isArray(outputFiles)) {
    return;
  }
  for (const file of outputFiles) {
    if (!file || typeof file !== "object") {
      continue;
    }
    if (file.encoding === "base64") {
      upsertArtifact({
        path: file.path,
        encoding: "base64",
        content: String(file.base64 ?? ""),
      });
    } else {
      upsertArtifact({
        path: file.path,
        encoding: "utf-8",
        content: String(file.text ?? ""),
      });
    }
  }
}

function getArtifactsForPaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  const artifacts = [];
  for (const pathValue of paths) {
    const path = normalizeRelativePath(pathValue);
    const artifact = artifactStore.get(path);
    if (!artifact) {
      throw new Error(`Missing required input artifact: ${path}`);
    }
    artifacts.push({ path: artifact.path, encoding: artifact.encoding, content: artifact.content });
  }
  return artifacts;
}

function enqueueJobUpdate(update) {
  const sequencedUpdate = {
    ...update,
    seq: ++jobUpdateSequence,
    timestamp: Date.now(),
  };
  jobUpdates.push(sequencedUpdate);

  postLog(
    `[broker] enqueue seq=${sequencedUpdate.seq} id=${String(sequencedUpdate.externalJobId ?? "")} status=${String(sequencedUpdate.status ?? "unknown")} total=${jobUpdates.length} active=${activeJobs.size} queued=${pendingJobQueue.length}`
  );

  if (jobUpdates.length > 5000) {
    jobUpdates.splice(0, jobUpdates.length - 5000);
    postLog(`[broker] trim updates=5000 lastSeq=${jobUpdateSequence}`);
  }
}

function buildJobResultFiles(resultFiles) {
  if (!Array.isArray(resultFiles)) {
    return [];
  }
  return resultFiles
    .map((file) => {
      if (!file || typeof file !== "object") {
        return null;
      }
      const path = normalizeRelativePath(file.path);
      if (file.encoding === "base64") {
        return {
          path,
          encoding: "base64",
          base64: String(file.base64 ?? ""),
        };
      }
      return {
        path,
        encoding: "utf-8",
        text: String(file.text ?? ""),
      };
    })
    .filter(Boolean);
}

function getEffectiveParallelJobs() {
  return Math.max(1, Math.min(MAX_CONCURRENT_SHELL_JOBS, Number(maxParallelJobs) || 1));
}

function toPlainValue(value) {
  if (value && typeof value === "object" && typeof value.toJs === "function") {
    try {
      return toPlainValue(value.toJs());
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toPlainValue(entry));
  }

  if (value && typeof value === "object") {
    const plainObject = {};
    for (const [key, entry] of Object.entries(value)) {
      plainObject[key] = toPlainValue(entry);
    }
    return plainObject;
  }

  return value;
}

function normalizeAsyncJobSpec(rawJobSpec) {
  const jobSpec = toPlainValue(rawJobSpec) ?? {};
  const outputPaths = Array.isArray(jobSpec.outputPaths)
    ? jobSpec.outputPaths.map((path) => String(path ?? "").trim()).filter((path) => path.length > 0)
    : [];
  const inputPaths = Array.isArray(jobSpec.inputPaths)
    ? jobSpec.inputPaths.map((path) => String(path ?? "").trim()).filter((path) => path.length > 0)
    : [];

  return {
    ...jobSpec,
    kind: String(jobSpec.kind ?? ""),
    command: String(jobSpec.command ?? ""),
    ruleName: String(jobSpec.ruleName ?? ""),
    jobId: String(jobSpec.jobId ?? ""),
    timeoutMs: Number.isFinite(jobSpec.timeoutMs) ? Number(jobSpec.timeoutMs) : 300000,
    outputPaths,
    inputPaths,
  };
}

async function executeQueuedJob(jobSpec) {
  const externalJobId = String(jobSpec.externalJobId ?? "");
  try {
    if (jobSpec.kind !== "shell") {
      throw new Error(`Unsupported async job kind: ${String(jobSpec.kind ?? "unknown")}`);
    }

    const command = String(jobSpec.command ?? "");
    const outputPaths = Array.isArray(jobSpec.outputPaths) ? jobSpec.outputPaths : [];
    const inputPaths = Array.isArray(jobSpec.inputPaths) ? jobSpec.inputPaths : [];
    const timeoutMs = Number.isFinite(jobSpec.timeoutMs) ? Number(jobSpec.timeoutMs) : 300000;
    const inputFiles = getArtifactsForPaths(inputPaths);
    const slotId = Number.isFinite(jobSpec.slotId) ? Number(jobSpec.slotId) : 0;

    postLog(
      `[async-job] start id=${externalJobId} kind=shell slot=${slotId} timeoutMs=${timeoutMs} inputPaths=${inputPaths.length} outputPaths=${outputPaths.length}`
    );

    const result = await runShellCommandViaHost(command, outputPaths, timeoutMs, {
      slotId,
      inputFiles,
    });

    postLog(
      `[async-job] shell result id=${externalJobId} exit=${Number.isFinite(result.exitCode) ? Number(result.exitCode) : 0} files=${Array.isArray(result.files) ? result.files.length : 0}`
    );

    if (cancelledAsyncJobIds.has(externalJobId)) {
      enqueueJobUpdate({
        externalJobId,
        status: "cancelled",
        error: "Cancelled during execution",
      });
      return;
    }

    const resultFiles = buildJobResultFiles(result.files);
    syncOutputArtifacts(
      resultFiles.map((file) =>
        file.encoding === "base64"
          ? { path: file.path, encoding: "base64", base64: file.base64 }
          : { path: file.path, encoding: "utf-8", text: file.text }
      )
    );

    enqueueJobUpdate({
      externalJobId,
      status: "success",
      exitCode: Number.isFinite(result.exitCode) ? Number(result.exitCode) : 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      files: resultFiles,
    });
  } catch (error) {
    postLog(`[async-job] error id=${externalJobId} ${String(error ?? "Unknown async job error")}`);
    if (cancelledAsyncJobIds.has(externalJobId)) {
      enqueueJobUpdate({
        externalJobId,
        status: "cancelled",
        error: "Cancelled during execution",
      });
      return;
    }
    enqueueJobUpdate({
      externalJobId,
      status: "error",
      error: String(error ?? "Unknown async job error"),
    });
  } finally {
    postLog(
      `[async-job] finalize id=${externalJobId} active=${activeJobs.size} queued=${pendingJobQueue.length}`
    );
    activeJobs.delete(externalJobId);
    cancelledAsyncJobIds.delete(externalJobId);
    void drainJobQueue();
  }
}

async function drainJobQueue() {
  const targetConcurrency = getEffectiveParallelJobs();
  postLog(
    `[async-queue] drain start target=${targetConcurrency} active=${activeJobs.size} queued=${pendingJobQueue.length}`
  );
  while (activeJobs.size < targetConcurrency && pendingJobQueue.length > 0) {
    const nextJob = pendingJobQueue.shift();
    const externalJobId = String(nextJob.externalJobId ?? "");
    activeJobs.set(externalJobId, nextJob);
    postLog(`[async-queue] dispatch id=${externalJobId} active=${activeJobs.size} queued=${pendingJobQueue.length}`);
    void executeQueuedJob(nextJob);
  }
  postLog(
    `[async-queue] drain end target=${targetConcurrency} active=${activeJobs.size} queued=${pendingJobQueue.length}`
  );
}

globalThis.submitSnakemakeAsyncJob = async (jobSpec) => {
  const normalizedJobSpec = normalizeAsyncJobSpec(jobSpec);
  const externalJobId = `job_${Date.now()}_${submittedJobCounter++}`;
  const slotModulo = getEffectiveParallelJobs();
  const slotId = Number.isFinite(normalizedJobSpec?.slotId)
    ? Number(normalizedJobSpec.slotId)
    : shellSlotCounter++ % slotModulo;
  pendingJobQueue.push({
    ...normalizedJobSpec,
    externalJobId,
    slotId,
  });
  postLog(
    `[async-queue] enqueue id=${externalJobId} kind=${String(normalizedJobSpec?.kind ?? "unknown")} slot=${slotId} queued=${pendingJobQueue.length} inputPaths=${normalizedJobSpec.inputPaths.length} outputPaths=${normalizedJobSpec.outputPaths.length} effectiveParallel=${slotModulo}`
  );
  void drainJobQueue();
  return externalJobId;
};

globalThis.pollSnakemakeAsyncJobUpdates = (lastSeq = 0) => {
  let numericLastSeq = 0;
  if (Number.isFinite(lastSeq)) {
    numericLastSeq = Number(lastSeq);
  } else if (lastSeq && typeof lastSeq === "object" && typeof lastSeq.toJs === "function") {
    try {
      const plainSeq = Number(lastSeq.toJs());
      numericLastSeq = Number.isFinite(plainSeq) ? plainSeq : 0;
    } catch {
      numericLastSeq = 0;
    }
  }

  const updates = jobUpdates.filter((update) => Number(update.seq) > numericLastSeq);
  postLog(
    `[broker] poll request lastSeq=${numericLastSeq} return=${updates.length} latestSeq=${jobUpdateSequence} active=${activeJobs.size} queued=${pendingJobQueue.length}`
  );
  return {
    updates,
    lastSeq: jobUpdateSequence,
  };
};

globalThis.cancelSnakemakeAsyncJobs = (jobIds) => {
  const ids = new Set(Array.isArray(jobIds) ? jobIds.map((jobId) => String(jobId)) : []);
  if (ids.size === 0) {
    return [];
  }

  const cancelled = [];
  for (let idx = pendingJobQueue.length - 1; idx >= 0; idx -= 1) {
    const queuedJob = pendingJobQueue[idx];
    const externalJobId = String(queuedJob.externalJobId ?? "");
    if (!ids.has(externalJobId)) {
      continue;
    }
    pendingJobQueue.splice(idx, 1);
    cancelled.push(externalJobId);
    enqueueJobUpdate({
      externalJobId,
      status: "cancelled",
      error: "Cancelled before execution",
    });
  }

  for (const [externalJobId] of activeJobs.entries()) {
    if (!ids.has(externalJobId)) {
      continue;
    }
    cancelledAsyncJobIds.add(externalJobId);
    cancelled.push(externalJobId);
  }

  return cancelled;
};

function getAllAsyncJobIds() {
  const ids = [];
  for (const pendingJob of pendingJobQueue) {
    const externalJobId = String(pendingJob.externalJobId ?? "");
    if (externalJobId) ids.push(externalJobId);
  }
  for (const [externalJobId] of activeJobs.entries()) {
    if (externalJobId) ids.push(String(externalJobId));
  }
  return ids;
}

function clearAsyncJobState() {
  pendingJobQueue.length = 0;
  activeJobs.clear();
  jobUpdates.length = 0;
  cancelledAsyncJobIds.clear();
}

const postLog = (text) => {
  postMessage({ type: "log", text: String(text) });
};

const postProgress = (payload) => {
  postMessage({ type: "progress", payload });
};

function runShellCommandViaHost(command, outputPaths = [], timeoutMs = 300000, options = {}) {
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
    const slotId = Number.isFinite(options.slotId) ? Math.max(0, Math.floor(Number(options.slotId))) : 0;
    const rawInputFiles = Array.isArray(options.inputFiles) ? options.inputFiles : [];
    const normalizedInputFiles = rawInputFiles
      .map((file) => {
        if (!file || typeof file !== "object") {
          return null;
        }
        try {
          return {
            path: normalizeRelativePath(file.path),
            encoding: file.encoding === "base64" ? "base64" : "utf-8",
            content: typeof file.content === "string" ? file.content : String(file.content ?? ""),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const timer = setTimeout(() => {
      pendingShellRuns.delete(requestId);
      postLog(`[shell-bridge] timeout request=${requestId} slot=${slotId} timeoutMs=${timeoutMs}`);
      reject(new Error(`Shell command timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    pendingShellRuns.set(requestId, { resolve, reject, timer });
    postLog(
      `[shell-bridge] post request=${requestId} workerSession=${workerSessionId} slot=${slotId} timeoutMs=${timeoutMs} outputs=${normalizedOutputPaths.length} inputs=${normalizedInputFiles.length} pending=${pendingShellRuns.size}`
    );
    postMessage({
      type: "shell-run-request",
      requestId,
      workerSessionId,
      command,
      outputPaths: normalizedOutputPaths,
      inputFiles: normalizedInputFiles,
      slotId,
      timeoutMs,
    });
  });
}

globalThis.runSnakemakeWasmShellCommand = async (command, outputPaths, options = {}) => {
  let normalizedOptions = options;
  if (normalizedOptions && typeof normalizedOptions === "object" && typeof normalizedOptions.toJs === "function") {
    try {
      normalizedOptions = normalizedOptions.toJs();
    } catch {
      normalizedOptions = {};
    }
  }

  const slotId = Number.isFinite(normalizedOptions?.slotId)
    ? Math.max(0, Math.floor(Number(normalizedOptions.slotId)))
    : 0;
  const timeoutMs = Number.isFinite(normalizedOptions?.timeoutMs)
    ? Math.max(1, Math.floor(Number(normalizedOptions.timeoutMs)))
    : 300000;
  const inputPaths = Array.isArray(normalizedOptions?.inputPaths)
    ? normalizedOptions.inputPaths
        .map((path) => String(path ?? "").trim())
        .filter((path) => path.length > 0)
    : [];

  const explicitInputFiles = Array.isArray(normalizedOptions?.inputFiles)
    ? normalizedOptions.inputFiles
        .map((file) => {
          if (!file || typeof file !== "object") {
            return null;
          }
          try {
            return {
              path: normalizeRelativePath(file.path),
              encoding: file.encoding === "base64" ? "base64" : "utf-8",
              content: typeof file.content === "string" ? file.content : String(file.content ?? ""),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  const artifactInputFiles = inputPaths.length > 0 ? getArtifactsForPaths(inputPaths) : [];
  const inputFilesByPath = new Map();
  for (const file of artifactInputFiles) {
    inputFilesByPath.set(file.path, file);
  }
  for (const file of explicitInputFiles) {
    inputFilesByPath.set(file.path, file);
  }
  const inputFiles = Array.from(inputFilesByPath.values());

  return runShellCommandViaHost(String(command ?? ""), outputPaths, timeoutMs, {
    slotId,
    inputFiles,
  });
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

async function ensureRuntimeSupported(pyodide) {
  const canRunSync = await pyodide.runPythonAsync(`
from pyodide.webloop import can_run_sync
can_run_sync()
`);

  if (!canRunSync) {
    throw new Error(
      "This browser/runtime does not support synchronous execution from Pyodide's event loop (can_run_sync() is false)."
    );
  }
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
    postLog("Checking runtime support (pyodide.webloop.can_run_sync)");
    await ensureRuntimeSupported(pyodide);
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
await micropip.install("snakemake==9.16.3", deps=True)
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

async function loadPackagesForCode(pyodide, code, label = "code") {
  const importScanCode = String(code ?? "");
  if (!importScanCode.trim()) return;

  try {
    postLog(`Resolving Python imports with pyodide.loadPackagesFromImports (${label})`);
    await pyodide.loadPackagesFromImports(importScanCode, {
      messageCallback: (message) => {
        postLog(`Import resolution progress (${label}): ${String(message ?? "")}`);
      },
      errorCallback: (message) => {
        postLog(`Import resolution warning (${label}): ${String(message ?? "")}`);
      },
      checkIntegrity: true,
    });
    postLog(`Import-based package resolution complete (${label})`);
  } catch (error) {
    postLog(
      `Import-based package resolution warning (${label}): ${error instanceof Error ? error.message : String(error)}`
    );
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
      return { path: normalizeRelativePath(path), encoding, content };
    })
    .filter(Boolean);
}

async function runWorkflow(pyodide, snakefileText, files, configYaml, parallelJobs) {
  const resolveImportsForCodeChunk = async (code, label = "code") => {
    await loadPackagesForCode(pyodide, code, String(label ?? "code"));
  };

  pyodide.globals.set("_resolve_imports_for_code_chunk", resolveImportsForCodeChunk);
  pyodide.globals.set("_snakefile_text", snakefileText);
  pyodide.globals.set("_worker_input_files", files);
  pyodide.globals.set("_workflow_config_yaml", configYaml);
  pyodide.globals.set("_worker_max_parallel_jobs", Number(parallelJobs) || 1);

  const resultJson = await pyodide.runPythonAsync(`
import asyncio
import json
import runpy
import sys
from pathlib import Path
import inspect

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
from snakemake_interface_common.exceptions import WorkflowError

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
worker_max_parallel_jobs = _as_python(_worker_max_parallel_jobs)
try:
  worker_max_parallel_jobs = max(1, int(worker_max_parallel_jobs))
except Exception:
  worker_max_parallel_jobs = 1

print("Python version:", sys.version)

def _ensure_import_packages_from_code(code_text, label):
  source = str(code_text or "")
  if not source.strip():
    return

  try:
    resolver = _resolve_imports_for_code_chunk
  except Exception as resolver_lookup_error:
    print(f"Import resolver unavailable ({label}): {resolver_lookup_error}")
    return

  async def _resolve_imports_async():
    await resolver(source, str(label))

  try:
    loop = asyncio.get_running_loop()
    loop.run_until_complete(_resolve_imports_async())
  except Exception as resolver_error:
    print(f"Import-based package resolution warning ({label}): {resolver_error}")

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

try:
  import snakemake.executors.local as _snakemake_local_executor

  _orig_local_run_wrapper = _snakemake_local_executor.run_wrapper
  _run_wrapper_signature = inspect.signature(_orig_local_run_wrapper)

  def _pyodide_run_wrapper(*args, **kwargs):
    try:
      bound_args = _run_wrapper_signature.bind_partial(*args, **kwargs)
      run_callable = bound_args.arguments.get("run")
      if callable(run_callable):
        run_label = f"run:{getattr(run_callable, '__name__', 'callable')}"
        try:
          run_source = inspect.getsource(run_callable)
          _ensure_import_packages_from_code(run_source, run_label)
        except Exception as run_source_error:
          print(f"Run source import scan warning ({run_label}): {run_source_error}")
    except Exception as run_wrapper_patch_error:
      print(f"run_wrapper import hook warning: {run_wrapper_patch_error}")

    return _orig_local_run_wrapper(*args, **kwargs)

  _snakemake_local_executor.run_wrapper = _pyodide_run_wrapper
  print("Patched snakemake run_wrapper import resolver for emscripten")
except Exception as _run_wrapper_patch_error:
  print(f"run_wrapper import resolver patch unavailable: {_run_wrapper_patch_error}")

try:
  import snakemake.script as _snakemake_script

  _orig_python_execute_script = _snakemake_script.PythonScript.execute_script
  _orig_bash_execute_script = _snakemake_script.BashScript.execute_script
  _orig_r_execute_script = _snakemake_script.RScript.execute_script

  def _materialize_script_result_files(result_dict, _base64_module):
    if not isinstance(result_dict, dict):
      return

    for file_entry in result_dict.get("files", []):
      if not isinstance(file_entry, dict):
        continue

      rel_path = str(file_entry.get("path", "")).strip()
      if not rel_path:
        continue
      if rel_path.startswith("/") or ".." in rel_path:
        raise RuntimeError(f"Rejected unsafe script output path: {rel_path!r}")

      out_path = Path(rel_path)
      out_path.parent.mkdir(parents=True, exist_ok=True)

      encoding = str(file_entry.get("encoding", "base64"))
      if encoding == "base64":
        payload = str(file_entry.get("base64", ""))
        out_path.write_bytes(_base64_module.b64decode(payload))
      elif encoding == "utf-8":
        out_path.write_text(str(file_entry.get("text", "")), encoding="utf-8")
      else:
        raise RuntimeError(
          f"Unsupported script output encoding {encoding!r} for {rel_path!r}"
        )

  def _collect_cross_runtime_input_files(path_values):
    input_files = []
    workspace_root = Path(".").resolve()

    for raw_path in path_values:
      path_text = str(raw_path or "").strip()
      if not path_text:
        continue

      original_path = Path(path_text)
      file_path = original_path
      relative_path = original_path

      if original_path.is_absolute():
        try:
          relative_path = original_path.resolve().relative_to(workspace_root)
          file_path = original_path.resolve()
        except Exception:
          continue
      else:
        file_path = (workspace_root / original_path).resolve()
        try:
          relative_path = file_path.relative_to(workspace_root)
        except Exception:
          continue

      relative_text = relative_path.as_posix()
      if not relative_text or relative_text.startswith("../") or relative_text == "..":
        continue
      if not file_path.exists() or not file_path.is_file():
        continue

      try:
        input_files.append(
          {
            "path": relative_text,
            "encoding": "utf-8",
            "content": file_path.read_text(encoding="utf-8"),
          }
        )
      except UnicodeDecodeError:
        import base64 as _base64

        input_files.append(
          {
            "path": relative_text,
            "encoding": "base64",
            "content": _base64.b64encode(file_path.read_bytes()).decode("ascii"),
          }
        )

    return input_files

  def _pyodide_python_execute_script(self, fname, edit=False, *args, **kwargs):
    if sys.platform != "emscripten":
      return _orig_python_execute_script(self, fname, edit=edit, *args, **kwargs)

    try:
      import os

      os.environ["MPLBACKEND"] = "Agg"
      import matplotlib

      matplotlib.use("Agg", force=True)
    except Exception as matplotlib_backend_error:
      print(f"Matplotlib backend setup warning: {matplotlib_backend_error}")

    script_path = Path(str(fname))
    if not script_path.exists():
      raise FileNotFoundError(f"Python script not found: {script_path}")

    script_parent = str(script_path.parent.resolve())
    if script_parent not in sys.path:
      sys.path.insert(0, script_parent)

    try:
      script_source = script_path.read_text(encoding="utf-8")
      _ensure_import_packages_from_code(script_source, f"script:{script_path.as_posix()}")
    except Exception as script_import_error:
      print(f"Script import scan warning ({script_path.as_posix()}): {script_import_error}")

    return runpy.run_path(str(script_path), run_name="__main__")

  def _pyodide_bash_execute_script(self, fname, edit=False, *args, **kwargs):
    if sys.platform != "emscripten":
      return _orig_bash_execute_script(self, fname, edit=edit, *args, **kwargs)

    script_path = Path(str(fname))
    if not script_path.exists():
      raise FileNotFoundError(f"Bash script not found: {script_path}")

    output_paths = []
    try:
      output_paths = [str(path) for path in getattr(self, "output", []) if str(path)]
    except Exception:
      output_paths = []

    input_paths = []
    try:
      input_paths = [str(path) for path in getattr(self, "input", []) if str(path)]
    except Exception:
      input_paths = []
    input_files = _collect_cross_runtime_input_files(input_paths)

    try:
      script_source = script_path.read_text(encoding="utf-8")
    except Exception:
      script_source = script_path.read_bytes().decode("utf-8", errors="replace")

    import base64 as _base64

    script_source_b64 = _base64.b64encode(script_source.encode("utf-8")).decode("ascii")
    command = f"printf '%s' '{script_source_b64}' | base64 -d | bash -se"

    from js import runSnakemakeWasmShellCommand

    async def _run_bash_script_async():
      return await runSnakemakeWasmShellCommand(
        command,
        output_paths,
        {
          "timeoutMs": 300000,
          "inputPaths": input_paths,
          "inputFiles": input_files,
        },
      )

    loop = asyncio.get_running_loop()
    result = loop.run_until_complete(_run_bash_script_async())

    if hasattr(result, "to_py"):
      result = result.to_py()

    exit_code = 0
    stderr = ""
    stdout = ""
    if isinstance(result, dict):
      try:
        exit_code = int(result.get("exitCode", 0) or 0)
      except Exception:
        exit_code = 0
      stderr = str(result.get("stderr", "") or "")
      stdout = str(result.get("stdout", "") or "")

    if exit_code != 0:
      raise RuntimeError(
        f"Bash script failed in v86 (exit {exit_code}): {stderr or stdout or command}"
      )

    _materialize_script_result_files(result, _base64)

    return result

  def _pyodide_r_execute_script(self, fname, edit=False, *args, **kwargs):
    if sys.platform != "emscripten":
      return _orig_r_execute_script(self, fname, edit=edit, *args, **kwargs)

    script_path = Path(str(fname))
    if not script_path.exists():
      raise FileNotFoundError(f"R script not found: {script_path}")

    output_paths = []
    try:
      output_paths = [str(path) for path in getattr(self, "output", []) if str(path)]
    except Exception:
      output_paths = []

    input_paths = []
    try:
      input_paths = [str(path) for path in getattr(self, "input", []) if str(path)]
    except Exception:
      input_paths = []
    input_files = _collect_cross_runtime_input_files(input_paths)

    try:
      script_source = script_path.read_text(encoding="utf-8")
    except Exception:
      script_source = script_path.read_bytes().decode("utf-8", errors="replace")

    from js import runSnakemakeWasmRScript

    async def _run_r_script_async():
      return await runSnakemakeWasmRScript(
        script_source,
        {
          "timeoutMs": 300000,
          "inputPaths": input_paths,
          "inputFiles": input_files,
          "outputPaths": output_paths,
        },
      )

    loop = asyncio.get_running_loop()
    result = loop.run_until_complete(_run_r_script_async())

    if hasattr(result, "to_py"):
      result = result.to_py()

    exit_code = 0
    stderr = ""
    stdout = ""
    bridge_error = ""
    if isinstance(result, dict):
      try:
        exit_code = int(result.get("exitCode", 0) or 0)
      except Exception:
        exit_code = 0
      stderr = str(result.get("stderr", "") or "")
      stdout = str(result.get("stdout", "") or "")
      bridge_error = str(result.get("error", "") or "")

    if exit_code != 0:
      error_parts = []
      if bridge_error:
        error_parts.append(f"bridge_error={bridge_error}")
      if stderr:
        error_parts.append(f"stderr={stderr}")
      if stdout:
        error_parts.append(f"stdout={stdout}")
      if not error_parts:
        error_parts.append(f"script={script_path.as_posix()}")

      raise RuntimeError(
        f"R script failed in webR (exit {exit_code}): {' | '.join(error_parts)}"
      )

    import base64 as _base64

    _materialize_script_result_files(result, _base64)

    return result

  _snakemake_script.PythonScript.execute_script = _pyodide_python_execute_script
  _snakemake_script.BashScript.execute_script = _pyodide_bash_execute_script
  _snakemake_script.RScript.execute_script = _pyodide_r_execute_script
  print("Patched snakemake PythonScript.execute_script for emscripten")
except Exception as _script_patch_error:
  print(f"Python script execution patch unavailable: {_script_patch_error}")

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
_ensure_import_packages_from_code(_snakefile_text, "Snakefile")
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


def _build_executor_settings():
  supported_params = set()
  try:
    supported_params = set(inspect.signature(ExecutorSettings).parameters.keys())
  except Exception as signature_error:
    print(f"ExecutorSettings signature introspection failed: {signature_error}")

  print("ExecutorSettings supported params:", sorted(supported_params))

  executor_kwargs = {}
  if "max_parallel_jobs" in supported_params:
    executor_kwargs["max_parallel_jobs"] = worker_max_parallel_jobs

  print("ExecutorSettings kwargs used:", executor_kwargs)

  try:
    return ExecutorSettings(**executor_kwargs)
  except TypeError as init_error:
    print(f"ExecutorSettings init with kwargs failed ({init_error}); falling back to defaults")
    return ExecutorSettings()

with SnakemakeApi(
    OutputSettings(
        verbose=True,
        show_failed_logs=True,
    )
) as api:
    workflow_api = api.workflow(
        resource_settings=ResourceSettings(
          cores=worker_max_parallel_jobs,
          nodes=worker_max_parallel_jobs,
        ),
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
    try:
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
          executor_settings=_build_executor_settings(),
          updated_files=updated_files,
      )
    #snakemake_interface_common.exceptions.WorkflowError
    except WorkflowError as workflow_error:
      print(f"Workflow execution failed with WorkflowError: {workflow_error}")
      ok = False
    except Exception as general_error:
      print(f"Workflow execution failed with unexpected error: {general_error}")
      ok = False

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
status["max_parallel_jobs"] = worker_max_parallel_jobs

json.dumps(status)
`);

  pyodide.globals.delete("_resolve_imports_for_code_chunk");
  pyodide.globals.delete("_snakefile_text");
  pyodide.globals.delete("_worker_input_files");
  pyodide.globals.delete("_workflow_config_yaml");
  pyodide.globals.delete("_worker_max_parallel_jobs");
  return JSON.parse(resultJson);
}

const handleWorkerMessage = (event) => {
  const msg = event.data || {};
  postLog(`[message] received type=${String(msg.type ?? "unknown")}`);

  if (typeof msg.pyodideIndexUrl === "string" && msg.pyodideIndexUrl.length > 0) {
    pyodideIndexUrl = msg.pyodideIndexUrl.endsWith("/") ? msg.pyodideIndexUrl : `${msg.pyodideIndexUrl}/`;
  }

  if (Number.isFinite(msg.maxParallelJobs)) {
    maxParallelJobs = Math.max(1, Math.floor(Number(msg.maxParallelJobs)));
  }

  if (msg.type === "init") {
    const wheels = Array.isArray(msg.wheels) ? msg.wheels : [];

    void (async () => {
      try {
        const pyodide = await getPyodide();
        await ensureRuntime(pyodide, wheels);
        postMessage({ type: "init-ready" });
      } catch (err) {
        const errorText = err && err.message ? err.message : String(err);
        postLog(`Runtime init failed: ${errorText}`);
        postMessage({ type: "init-error", error: errorText });
      }
    })();
    return;
  }

  if (msg.type === "shell-run-response") {
    const requestId = String(msg.requestId || "");
    const responseWorkerSessionId = String(msg.workerSessionId || "");
    if (responseWorkerSessionId && responseWorkerSessionId !== workerSessionId) {
      postLog(
        `[shell-bridge] response worker-session mismatch request=${requestId} expected=${workerSessionId} actual=${responseWorkerSessionId}`
      );
    }
    const pending = pendingShellRuns.get(requestId);
    if (!pending) {
      postLog(
        `[shell-bridge] response with no pending request id=${requestId} workerSession=${workerSessionId} actualWorkerSession=${responseWorkerSessionId || "n/a"} pending=${pendingShellRuns.size}`
      );
      return;
    }

    clearTimeout(pending.timer);
    pendingShellRuns.delete(requestId);
    postLog(
      `[shell-bridge] response id=${requestId} workerSession=${workerSessionId} ok=${Boolean(msg.ok)} exit=${Number.isFinite(msg.exitCode) ? Number(msg.exitCode) : "n/a"} files=${Array.isArray(msg.files) ? msg.files.length : 0} pending=${pendingShellRuns.size}`
    );

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

    const pendingAsyncJobIds = getAllAsyncJobIds();
    if (pendingAsyncJobIds.length > 0) {
      try {
        globalThis.cancelSnakemakeAsyncJobs(pendingAsyncJobIds);
      } catch (error) {
        postLog(`Failed to cancel async jobs: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

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
  postLog(
    `[run] message received snakefileBytes=${snakefile.length} configBytes=${configYaml.length} files=${files.length} wheels=${wheels.length} maxParallelJobs=${maxParallelJobs}`
  );
  clearAsyncJobState();
  seedArtifactStore(snakefile, files, configYaml);
  const storeBackedFiles = buildInputFilesFromArtifactStore();
  postLog(`[run] artifact store prepared files=${storeBackedFiles.length}`);

  cancelled = false;

  void (async () => {
    try {
      postProgress({ stage: "run", status: "starting" });
      const pyodide = await getPyodide();

      if (cancelled) {
        throw new Error("Run cancelled before runtime initialization");
      }

      await ensureRuntime(pyodide, wheels);

      await loadPackagesForCode(pyodide, snakefile, "Snakefile");

      if (cancelled) {
        throw new Error("Run cancelled before workflow execution");
      }

      postLog("Starting Snakemake workflow");
      const effectiveParallelJobs = getEffectiveParallelJobs();
      postLog(`Configured max parallel jobs: ${maxParallelJobs}`);
      postLog(`Effective shell parallel jobs: ${effectiveParallelJobs}`);
      postProgress({ stage: "workflow", status: "running" });

      const payload = await runWorkflow(
        pyodide,
        snakefile,
        storeBackedFiles,
        configYaml,
        effectiveParallelJobs
      );
      syncOutputArtifacts(payload?.output_files);
      // postProgress({ stage: "workflow", status: "finished" });
      postMessage({ type: "result", payload });
    } catch (err) {
      const errorText = err && err.message ? err.message : String(err);
      postLog(`Workflow failed: ${errorText}`);
      postMessage({ type: "error", error: errorText });
    }
  })();

  return;
};

let workerMessageListenerInstalled = false;
if (!workerMessageListenerInstalled) {
  self.addEventListener("message", handleWorkerMessage);
  workerMessageListenerInstalled = true;
  postLog("[worker] message listener installed via addEventListener");
}
