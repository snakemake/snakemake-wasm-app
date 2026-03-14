from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
import os
from pathlib import Path
import sys
import time
from typing import Optional

from snakemake_interface_executor_plugins.executors.base import SubmittedJobInfo
from snakemake_interface_executor_plugins.executors.real import RealExecutor
from snakemake_interface_executor_plugins.jobs import JobExecutorInterface
from snakemake_interface_executor_plugins.settings import (
    ExecutorSettingsBase,
    CommonSettings,
    ExecMode,
)
from snakemake_interface_common.exceptions import WorkflowError


@dataclass
class ExecutorSettings(ExecutorSettingsBase):
    worker_url: Optional[str] = field(
        default=None,
        metadata={"help": "URL of the module web worker script."},
    )
    pyodide_base_url: Optional[str] = field(
        default=None,
        metadata={"help": "Base URL of the Pyodide distribution used in workers."},
    )
    wheels_json: Optional[str] = field(
        default=None,
        metadata={"help": "JSON array of wheel URLs to install inside workers."},
    )
    max_parallel_jobs: int = field(
        default=1,
        metadata={"help": "Maximum number of parallel job workers (1 core per worker)."},
    )
    status_poll_interval_ms: int = field(
        default=200,
        metadata={"help": "Polling interval in milliseconds for asynchronous job status checks."},
    )


common_settings = CommonSettings(
    non_local_exec=False,
    implies_no_shared_fs=False,
    job_deploy_sources=False,
    pass_envvar_declarations_to_cmd=True,
    auto_deploy_default_storage_provider=False,
)


def _plain_list(x) -> list[str]:
    if x is None:
        return []

    if isinstance(x, (str, Path)):
        text = str(x).strip()
        return [text] if text else []

    fspath = getattr(x, "__fspath__", None)
    if callable(fspath):
        try:
            text = str(os.fspath(x)).strip()
            return [text] if text else []
        except Exception:
            pass

    values: list[str] = []
    try:
        iterator = iter(x)
    except Exception:
        return values

    for value in iterator:
        try:
            text = str(value)
        except Exception:
            continue
        if text:
            values.append(text)
    return values


def _plain_mapping(x) -> dict:
    try:
        return dict(x.items())
    except Exception:
        try:
            return dict(x)
        except Exception:
            return {}


def _path_list(value) -> list[str]:
    if value is None:
        return []

    if isinstance(value, (str, Path)):
        text = str(value).strip()
        return [text] if text else []

    fspath = getattr(value, "__fspath__", None)
    if callable(fspath):
        try:
            text = str(os.fspath(value)).strip()
            return [text] if text else []
        except Exception:
            pass

    plainstrings = getattr(value, "_plainstrings", None)
    if callable(plainstrings):
        try:
            return [str(v) for v in plainstrings() if str(v)]
        except Exception:
            pass
    elif plainstrings is not None:
        try:
            return [str(v) for v in plainstrings if str(v)]
        except Exception:
            pass

    strings = getattr(value, "plainstrings", None)
    if callable(strings):
        try:
            return [str(v) for v in strings() if str(v)]
        except Exception:
            pass
    elif strings is not None:
        try:
            return [str(v) for v in strings if str(v)]
        except Exception:
            pass

    return [str(v) for v in _plain_list(value) if str(v)]


def _format_rule_paths(job: JobExecutorInterface, rule_value) -> list[str]:
    formatted: list[str] = []
    for raw in _plain_list(rule_value):
        text = str(raw).strip()
        if not text:
            continue
        try:
            text = str(job.format_wildcards(text))
        except Exception:
            pass
        text = text.strip()
        if text:
            formatted.append(text)
    return formatted


def _dedupe_paths(paths: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for path in paths:
        normalized = str(path).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _placeholder_paths(job: JobExecutorInterface, placeholder: str) -> list[str]:
    try:
        rendered = str(job.format_wildcards("{" + placeholder + "}"))
    except Exception:
        return []
    return _dedupe_paths([part for part in rendered.split() if part.strip()])


def _job_paths(job: JobExecutorInterface, attr_name: str) -> list[str]:
    direct_paths = _path_list(getattr(job, attr_name, None))
    if direct_paths:
        return _dedupe_paths(direct_paths)

    rule = getattr(job, "rule", None)
    if rule is None:
        placeholder_paths = _placeholder_paths(job, attr_name)
        return _dedupe_paths(placeholder_paths)

    rule_paths = _format_rule_paths(job, getattr(rule, attr_name, None))
    if rule_paths:
        return _dedupe_paths(rule_paths)

    placeholder_paths = _placeholder_paths(job, attr_name)
    return _dedupe_paths(placeholder_paths)


def _is_safe_relative_path(path_value: str) -> bool:
    normalized = str(path_value).strip()
    if not normalized:
        return False
    if normalized.startswith("/"):
        return False
    if ".." in normalized:
        return False
    return True


class Executor(RealExecutor):
    def __post_init__(self):
        super_post_init = getattr(super(), "__post_init__", None)
        if callable(super_post_init):
            super_post_init()
        self._async_shell_jobs: dict[str, SubmittedJobInfo] = {}
        self._async_shell_submitted_at: dict[str, float] = {}
        self._async_run_jobs: dict[str, tuple[SubmittedJobInfo, asyncio.Task]] = {}
        self._async_run_submitted_at: dict[str, float] = {}
        self._warned_sync_run_parallel_limit = False
        self._run_job_counter = 0
        self._job_update_cursor = 0

    def get_exec_mode(self):
        return ExecMode.SUBPROCESS

    def get_python_executable(self):
        return sys.executable

    @staticmethod
    def _total_file_size_mb(paths: list[str]) -> float:
        total_mb = 0.0
        for raw_path in paths:
            path_str = str(raw_path).strip()
            if not path_str:
                continue
            try:
                path = Path(path_str)
                if path.exists() and path.is_file():
                    total_mb += path.stat().st_size / 1024.0 / 1024.0
            except Exception:
                continue
        return total_mb

    def _ensure_shell_benchmark_files(
        self,
        job: JobExecutorInterface,
        running_time_s: Optional[float] = None,
    ) -> None:
        benchmark_paths = _job_paths(job, "benchmark")
        if not benchmark_paths:
            return

        input_paths = _job_paths(job, "input")
        output_paths = _dedupe_paths(
            [
                *_job_paths(job, "output"),
                *_job_paths(job, "benchmark"),
                *_job_paths(job, "log"),
            ]
        )
        io_in_mb = self._total_file_size_mb(input_paths)
        io_out_mb = self._total_file_size_mb(output_paths)

        try:
            duration = float(running_time_s) if running_time_s is not None else 0.0
        except Exception:
            duration = 0.0
        duration = max(0.0, duration)
        duration_for_record = max(duration, 1e-9)

        for rel_path in benchmark_paths:
            rel_path = str(rel_path).strip()
            if not _is_safe_relative_path(rel_path):
                raise WorkflowError(f"Rejected unsafe benchmark output path: {rel_path!r}")

            benchmark_path = Path(rel_path)
            if benchmark_path.exists():
                continue

            benchmark_path.parent.mkdir(parents=True, exist_ok=True)

            wrote_benchmark = False
            try:
                from snakemake.benchmark import BenchmarkRecord, write_benchmark_records

                benchmark_record = BenchmarkRecord()
                benchmark_record.jobid = getattr(job, "jobid", None)
                benchmark_record.rule_name = getattr(getattr(job, "rule", None), "name", "")
                benchmark_record.wildcards = getattr(job, "wildcards", {})
                benchmark_record.params = getattr(job, "params", {})
                benchmark_record.resources = getattr(job, "resources", {})
                benchmark_record.input = input_paths
                benchmark_record.threads = 1
                benchmark_record.running_time = duration_for_record
                benchmark_record.cpu_time = duration
                benchmark_record.cpu_usage = 0.0
                benchmark_record.io_in = io_in_mb
                benchmark_record.io_out = io_out_mb
                benchmark_record.max_rss = None
                benchmark_record.max_vms = None
                benchmark_record.max_uss = None
                benchmark_record.max_pss = None
                benchmark_record.data_collected = True

                write_benchmark_records(
                    [benchmark_record],
                    str(benchmark_path),
                    self.workflow.output_settings.benchmark_extended,
                )
                wrote_benchmark = True
            except Exception:
                wrote_benchmark = False

            if not wrote_benchmark:
                benchmark_path.write_text("s\n0\n", encoding="utf-8")

    @staticmethod
    def _job_key(job: JobExecutorInterface) -> str:
        try:
            jobid = getattr(job, "jobid", None)
            if jobid is not None:
                text = str(jobid).strip()
                if text:
                    return text
        except Exception:
            pass
        return str(id(job))

    def _debug_log(self, message: str) -> None:
        logger = getattr(self, "logger", None)
        if logger is not None and hasattr(logger, "info"):
            logger.info(f"[executor-debug] {message}")

    def _status_poll_interval_seconds(self) -> float:
        try:
            value_ms = int(getattr(self.executor_settings, "status_poll_interval_ms", 200) or 200)
        except Exception:
            value_ms = 200
        return max(0.0, value_ms / 1000.0)

    @property
    def job_specific_local_groupid(self):
        return False

    @property
    def cores(self):
        try:
            value = int(getattr(self.executor_settings, "max_parallel_jobs", 1) or 1)
        except Exception:
            value = 1
        return max(2, value)

    def job_args_and_prepare(self, job: JobExecutorInterface) -> dict:
        self.workflow.async_run(job.prepare())

        return {
            "rule_name": job.rule.name,
            "input": _plain_list(job.input),
            "output": _plain_list(job.output),
            "params": _plain_mapping(job.params),
            "wildcards": dict(getattr(job, "wildcards_dict", {})),
            "threads": 1,
            "resources": _plain_mapping(job.resources),
            "log": _plain_list(job.log),
            "workdir": str(getattr(self.workflow, "workdir_init", ".")),
        }

    def _validate_job(self, job: JobExecutorInterface):
        if job.is_group():
            raise WorkflowError("wasm executor does not support group jobs yet")

        try:
            threads = int(getattr(job, "threads", 1) or 1)
        except Exception:
            threads = 1

        if threads != 1:
            logger = getattr(self, "logger", None)
            if logger is not None and hasattr(logger, "warning"):
                logger.warning(
                    "wasm executor supports only threads=1; forcing rule %r jobid=%r threads %r -> 1",
                    getattr(getattr(job, "rule", None), "name", "<unknown>"),
                    getattr(job, "jobid", None),
                    threads,
                )

            try:
                setattr(job, "threads", 1)
            except Exception:
                pass

    @staticmethod
    def _rule_has_directive_action(job: JobExecutorInterface) -> bool:
        rule = job.rule
        return any(
            (
                getattr(rule, "script", None),
                getattr(rule, "wrapper", None),
                getattr(rule, "cwl", None),
            )
        )

    @staticmethod
    def _resolve_shell_command(job: JobExecutorInterface) -> Optional[str]:
        job_shellcmd = getattr(job, "shellcmd", None)
        if isinstance(job_shellcmd, str) and job_shellcmd.strip():
            return job_shellcmd

        rule_shellcmd = getattr(job.rule, "shellcmd", None)
        if isinstance(rule_shellcmd, str) and rule_shellcmd.strip():
            try:
                return str(job.format_wildcards(rule_shellcmd))
            except Exception:
                return rule_shellcmd

        return None

    def _execute_shell_rule(self, job: JobExecutorInterface):
        command = self._resolve_shell_command(job)
        if not command:
            raise WorkflowError(
                f"wasm executor could not resolve shell command for rule {job.rule.name!r}"
            )
        output_paths = _dedupe_paths(
            [
                *_job_paths(job, "output"),
                *_job_paths(job, "benchmark"),
                *_job_paths(job, "log"),
            ]
        )
        input_paths = _job_paths(job, "input")

        try:
            from js import runSnakemakeWasmShellCommand
        except Exception as e:
            raise WorkflowError(
                "Missing JS bridge function runSnakemakeWasmShellCommand in worker global scope"
            ) from e

        async def _run_shell():
            started_at = time.perf_counter()
            result = await runSnakemakeWasmShellCommand(
                command,
                output_paths,
                {
                    "inputPaths": input_paths,
                },
            )
            try:
                result = result.to_py()
            except Exception:
                pass

            if not isinstance(result, dict):
                raise WorkflowError(
                    f"Invalid shell bridge response for rule {job.rule.name!r}: {result!r}"
                )

            exit_code = int(result.get("exitCode", 1))
            if exit_code != 0:
                stdout = str(result.get("stdout", ""))
                stderr = str(result.get("stderr", ""))
                raise WorkflowError(
                    f"Shell command failed for rule {job.rule.name!r} with exit code {exit_code}.\n"
                    f"Command: {command}\n"
                    f"stdout:\n{stdout}\n"
                    f"stderr:\n{stderr}"
                )

            for file_entry in result.get("files", []):
                if not isinstance(file_entry, dict):
                    continue
                rel_path = str(file_entry.get("path", "")).strip()
                if not rel_path:
                    continue
                if rel_path.startswith("/") or ".." in rel_path:
                    raise WorkflowError(f"Rejected unsafe shell output path: {rel_path!r}")

                file_path = Path(rel_path)
                file_path.parent.mkdir(parents=True, exist_ok=True)

                encoding = str(file_entry.get("encoding", "base64"))
                if encoding == "base64":
                    payload = str(file_entry.get("base64", ""))
                    file_path.write_bytes(base64.b64decode(payload))
                elif encoding == "utf-8":
                    file_path.write_text(
                        str(file_entry.get("text", "")), encoding="utf-8"
                    )
                else:
                    raise WorkflowError(
                        f"Unsupported shell output encoding {encoding!r} for {rel_path!r}"
                    )

            self._ensure_shell_benchmark_files(
                job,
                running_time_s=(time.perf_counter() - started_at),
            )
            self._ensure_shell_log_files(job)

        self.workflow.async_run(_run_shell())

    async def _execute_shell_rule_async(self, job: JobExecutorInterface, slot_id: int = 0):
        command = self._resolve_shell_command(job)
        if not command:
            raise WorkflowError(
                f"wasm executor could not resolve shell command for rule {job.rule.name!r}"
            )
        output_paths = _dedupe_paths(
            [
                *_job_paths(job, "output"),
                *_job_paths(job, "benchmark"),
                *_job_paths(job, "log"),
            ]
        )
        input_paths = _job_paths(job, "input")

        try:
            from js import runSnakemakeWasmShellCommand
        except Exception as e:
            raise WorkflowError(
                "Missing JS bridge function runSnakemakeWasmShellCommand in worker global scope"
            ) from e

        started_at = time.perf_counter()
        result = await runSnakemakeWasmShellCommand(
            command,
            output_paths,
            {
                "slotId": int(max(0, slot_id)),
                "inputPaths": input_paths,
            },
        )
        try:
            result = result.to_py()
        except Exception:
            pass

        if not isinstance(result, dict):
            raise WorkflowError(
                f"Invalid shell bridge response for rule {job.rule.name!r}: {result!r}"
            )

        exit_code = int(result.get("exitCode", 1))
        if exit_code != 0:
            stdout = str(result.get("stdout", ""))
            stderr = str(result.get("stderr", ""))
            raise WorkflowError(
                f"Shell command failed for rule {job.rule.name!r} with exit code {exit_code}.\n"
                f"Command: {command}\n"
                f"stdout:\n{stdout}\n"
                f"stderr:\n{stderr}"
            )

        self._materialize_synced_files(result.get("files", []))
        self._ensure_shell_benchmark_files(
            job,
            running_time_s=(time.perf_counter() - started_at),
        )
        self._ensure_shell_log_files(job)

    def _materialize_synced_files(self, files) -> None:
        if not isinstance(files, list):
            return
        for file_entry in files:
            if not isinstance(file_entry, dict):
                continue
            rel_path = str(file_entry.get("path", "")).strip()
            if not rel_path:
                continue
            if rel_path.startswith("/") or ".." in rel_path:
                raise WorkflowError(f"Rejected unsafe async output path: {rel_path!r}")

            file_path = Path(rel_path)
            file_path.parent.mkdir(parents=True, exist_ok=True)

            encoding = str(file_entry.get("encoding", "base64"))
            if encoding == "base64":
                payload = str(file_entry.get("base64", ""))
                file_path.write_bytes(base64.b64decode(payload))
            elif encoding == "utf-8":
                file_path.write_text(str(file_entry.get("text", "")), encoding="utf-8")
            else:
                raise WorkflowError(
                    f"Unsupported async output encoding {encoding!r} for {rel_path!r}"
                )

    def _ensure_shell_log_files(self, job: JobExecutorInterface) -> None:
        log_paths = _job_paths(job, "log")
        if not log_paths:
            return

        for rel_path in log_paths:
            rel_path = str(rel_path).strip()
            if not rel_path:
                continue
            if not _is_safe_relative_path(rel_path):
                raise WorkflowError(f"Rejected unsafe log output path: {rel_path!r}")

            file_path = Path(rel_path)
            if file_path.exists():
                continue

            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text("", encoding="utf-8")

    def _submit_async_shell_job(self, job: JobExecutorInterface) -> str:
        command = self._resolve_shell_command(job)
        if not command:
            raise WorkflowError(
                f"wasm executor could not resolve shell command for rule {job.rule.name!r}"
            )

        output_paths = _dedupe_paths(
            [
                *_job_paths(job, "output"),
                *_job_paths(job, "benchmark"),
                *_job_paths(job, "log"),
            ]
        )
        input_paths = _job_paths(job, "input")

        logger = getattr(self, "logger", None)
        if logger is not None and hasattr(logger, "info"):
            logger.info(
                f"async shell paths rule={job.rule.name!r} outputs={output_paths!r} inputs={input_paths!r} "
                f"job_output_type={type(getattr(job, 'output', None)).__name__} "
                f"rule_output_type={type(getattr(getattr(job, 'rule', None), 'output', None)).__name__}"
            )
        timeout_ms = 300000
        try:
            from js import submitSnakemakeAsyncJob
        except Exception as e:
            raise WorkflowError(
                "Missing JS bridge function submitSnakemakeAsyncJob in worker global scope"
            ) from e

        async def _submit_job():
            return await submitSnakemakeAsyncJob(
                {
                    "kind": "shell",
                    "command": command,
                    "inputPaths": input_paths,
                    "outputPaths": output_paths,
                    "timeoutMs": timeout_ms,
                    "ruleName": str(job.rule.name),
                    "jobId": str(job.jobid),
                }
            )

        external_job_id = str(self.workflow.async_run(_submit_job())).strip()
        if not external_job_id:
            raise WorkflowError(
                f"Async shell submission returned empty external job id for rule {job.rule.name!r}"
            )
        if external_job_id in self._async_shell_jobs:
            raise WorkflowError(
                f"Duplicate async external job id {external_job_id!r} for rule {job.rule.name!r}"
            )
        self._async_shell_submitted_at[external_job_id] = time.perf_counter()
        return external_job_id

    def _job_args_for_run_wrapper(self, job: JobExecutorInterface):
        from snakemake.executors.local import DeploymentMethod

        conda_env = (
            job.conda_env.address
            if DeploymentMethod.CONDA
            in self.workflow.deployment_settings.deployment_method
            and job.conda_env
            else None
        )
        container_img = (
            job.container_img_path
            if DeploymentMethod.APPTAINER
            in self.workflow.deployment_settings.deployment_method
            else None
        )
        env_modules = (
            job.env_modules
            if DeploymentMethod.ENV_MODULES
            in self.workflow.deployment_settings.deployment_method
            else None
        )

        benchmark = None
        benchmark_repeats = job.benchmark_repeats or 1
        # In wasm context, benchmark records are written by executor-side handling
        # to avoid run_wrapper benchmark records with incomplete process metrics.
        if job.benchmark is not None:
            benchmark = None

        return (
            job.rule,
            job.input._plainstrings(),
            job.output._plainstrings(),
            job.params,
            job.wildcards,
            job.threads,
            job.resources,
            job.log._plainstrings(),
            benchmark,
            benchmark_repeats,
            self.workflow.output_settings.benchmark_extended,
            conda_env,
            container_img,
            self.workflow.deployment_settings.apptainer_args,
            env_modules,
            DeploymentMethod.APPTAINER
            in self.workflow.deployment_settings.deployment_method,
            self.workflow.linemaps,
            self.workflow.execution_settings.debug,
            self.workflow.execution_settings.cleanup_scripts,
            job.shadow_dir,
            job.jobid,
            (
                self.workflow.execution_settings.edit_notebook
                if self.dag.is_edit_notebook_job(job)
                else None
            ),
            self.workflow.conda_base_path,
            job.rule.basedir,
            self.workflow.sourcecache.cache_path,
            self.workflow.sourcecache.runtime_cache_path,
            self.workflow.runtime_paths,
        )

    def _execute_run_rule(self, job: JobExecutorInterface):
        from snakemake.executors.local import run_wrapper
        started_at = time.perf_counter()
        run_wrapper(*self._job_args_for_run_wrapper(job))
        self._ensure_shell_benchmark_files(
            job,
            running_time_s=(time.perf_counter() - started_at),
        )

    def _submit_async_run_job(self, job: JobExecutorInterface, job_info: SubmittedJobInfo) -> str:
        external_job_id = f"run_{job.jobid}_{self._run_job_counter}"
        self._run_job_counter += 1

        if external_job_id in self._async_run_jobs:
            raise WorkflowError(
                f"Duplicate async run external job id {external_job_id!r} for rule {job.rule.name!r}"
            )

        async def _execute() -> None:
            self._execute_run_rule(job)

        task = asyncio.create_task(_execute())
        self._async_run_jobs[external_job_id] = (job_info, task)
        self._async_run_submitted_at[external_job_id] = time.perf_counter()
        return external_job_id

    def run_jobs(self, jobs: list[JobExecutorInterface]):
        shell_jobs: list[tuple[SubmittedJobInfo, JobExecutorInterface]] = []

        for job in jobs:
            self.run_job_pre(job)
            job_info = SubmittedJobInfo(job=job)

            try:
                self._validate_job(job)
                self.job_args_and_prepare(job)

                self.report_job_submission(job_info)

                if self._resolve_shell_command(job):
                    shell_jobs.append((job_info, job))
                    continue

                if not getattr(job, "is_run", False) and not self._rule_has_directive_action(job):
                    self.report_job_success(job_info)
                    continue

                self._execute_run_rule(job)
                self.report_job_success(job_info)
            except WorkflowError:
                self.report_job_error(job_info, msg="WorkflowError in wasm executor")
                raise
            except Exception as e:
                self.report_job_error(job_info, msg=str(e))
                raise WorkflowError(f"Failed to execute wasm job: {e}") from e

        if not shell_jobs:
            return

        async def _run_shell_batch() -> None:
            semaphore = asyncio.Semaphore(self.cores)
            errors: list[WorkflowError] = []
            slot_span = max(1, self.cores)

            async def _run_one(
                job_info: SubmittedJobInfo,
                job: JobExecutorInterface,
                slot_id: int,
            ) -> None:
                async with semaphore:
                    try:
                        await self._execute_shell_rule_async(job, slot_id=slot_id)
                    except WorkflowError as error:
                        self.report_job_error(job_info, msg=str(error))
                        errors.append(error)
                    except Exception as error:
                        workflow_error = WorkflowError(f"Failed to execute wasm shell job: {error}")
                        self.report_job_error(job_info, msg=str(workflow_error))
                        errors.append(workflow_error)
                    else:
                        self.report_job_success(job_info)

            await asyncio.gather(
                *[
                    _run_one(job_info, job, slot_id=(index % slot_span))
                    for index, (job_info, job) in enumerate(shell_jobs)
                ]
            )

            if errors:
                raise errors[0]

        self.workflow.async_run(_run_shell_batch())

    def run_job(self, job: JobExecutorInterface):
        self.run_jobs([job])
        return

    def run_job_legacy(self, job: JobExecutorInterface):
        job_info = SubmittedJobInfo(job=job)

        try:
            self._validate_job(job)
            self.job_args_and_prepare(job)

            self.report_job_submission(job_info)

            if self._resolve_shell_command(job):
                external_job_id = self._submit_async_shell_job(job)
                self._async_shell_jobs[external_job_id] = job_info
                return

            if not getattr(job, "is_run", False) and not self._rule_has_directive_action(job):
                self.report_job_success(job_info)
                return

            if self.cores > 1 and not self._warned_sync_run_parallel_limit:
                logger = getattr(self, "logger", None)
                if logger is not None and hasattr(logger, "warning"):
                    logger.warning(
                        "run: rules execute via async task submission in wasm executor; "
                        "true concurrent run-rule execution is limited by Pyodide runtime constraints"
                    )
                self._warned_sync_run_parallel_limit = True

            self._submit_async_run_job(job, job_info)
            return
        except WorkflowError:
            self.report_job_error(job_info, msg="WorkflowError in wasm executor")
            raise
        except Exception as e:
            self.report_job_error(job_info, msg=str(e))
            raise WorkflowError(f"Failed to execute wasm job: {e}") from e

    async def check_active_jobs(self, active_jobs):
        await asyncio.sleep(0)
        active_job_infos = list(active_jobs)
        active_job_keys = [self._job_key(active_job_info.job) for active_job_info in active_job_infos]
        self._debug_log(
            "poll begin "
            f"cursor={self._job_update_cursor} "
            f"active_jobs={len(active_job_infos)} "
            f"shell_jobs={len(self._async_shell_jobs)} "
            f"run_jobs={len(self._async_run_jobs)} "
            f"active_keys={active_job_keys}"
        )

        try:
            from js import pollSnakemakeAsyncJobUpdates
        except Exception:
            self._debug_log("poll bridge missing; yielding all active jobs")
            for active_job_info in active_job_infos:
                yield active_job_info
            return

        raw_updates = pollSnakemakeAsyncJobUpdates(self._job_update_cursor)
        self._debug_log(f"poll bridge response type={type(raw_updates).__name__}")
        try:
            updates = raw_updates.to_py()
        except Exception:
            updates = raw_updates

        if isinstance(updates, dict):
            last_seq = updates.get("lastSeq")
            try:
                self._job_update_cursor = max(self._job_update_cursor, int(last_seq))
            except Exception:
                pass
            self._debug_log(
                f"poll envelope dict lastSeq={last_seq!r} cursor={self._job_update_cursor} updatesType={type(updates.get('updates')).__name__}"
            )
            updates = updates.get("updates", [])
        elif isinstance(updates, list):
            self._debug_log(f"poll envelope list updates={len(updates)} cursor={self._job_update_cursor}")
        else:
            self._debug_log(f"poll envelope unsupported type={type(updates).__name__}; treating as empty")
            updates = []

        if not updates and (self._async_shell_jobs or self._async_run_jobs):
            poll_sleep = self._status_poll_interval_seconds()
            if poll_sleep > 0:
                self._debug_log(f"poll idle; sleeping {poll_sleep:.3f}s before next scheduler cycle")
                await asyncio.sleep(poll_sleep)

        completed_ids: set[str] = set()
        completed_job_keys: set[str] = set()
        self._debug_log(f"processing updates count={len(updates)}")
        for update in updates:
            if not isinstance(update, dict):
                self._debug_log(f"skip non-dict update type={type(update).__name__}")
                continue
            external_job_id = str(update.get("externalJobId", "")).strip()
            if not external_job_id:
                self._debug_log(f"skip update without externalJobId payload={update!r}")
                continue
            job_info = self._async_shell_jobs.get(external_job_id)
            if job_info is None:
                self._debug_log(
                    f"update id={external_job_id} status={update.get('status')!r} not matched in shell map keys={list(self._async_shell_jobs.keys())}"
                )
                continue

            status = str(update.get("status", "")).strip().lower()
            self._debug_log(
                f"update match id={external_job_id} status={status!r} job_key={self._job_key(job_info.job)}"
            )
            if status == "success":
                self._materialize_synced_files(update.get("files", []))
                started_at = self._async_shell_submitted_at.get(external_job_id)
                duration = None
                if started_at is not None:
                    duration = max(0.0, time.perf_counter() - started_at)
                self._ensure_shell_benchmark_files(job_info.job, running_time_s=duration)
                self._ensure_shell_log_files(job_info.job)
                self.report_job_success(job_info)
                completed_ids.add(external_job_id)
                completed_job_keys.add(self._job_key(job_info.job))
            elif status in {"error", "failed", "cancelled"}:
                error_text = str(update.get("error", "Async job failed"))
                self.report_job_error(job_info, msg=error_text)
                completed_ids.add(external_job_id)
                completed_job_keys.add(self._job_key(job_info.job))
            else:
                self._debug_log(
                    f"update id={external_job_id} ignored status={status!r} payload={update!r}"
                )

        completed_run_ids: set[str] = set()
        for run_id, (run_job_info, run_task) in list(self._async_run_jobs.items()):
            if not run_task.done():
                continue
            completed_run_ids.add(run_id)
            completed_job_keys.add(self._job_key(run_job_info.job))
            try:
                run_task.result()
            except asyncio.CancelledError:
                self.report_job_error(run_job_info, msg="Async run job cancelled")
            except WorkflowError as error:
                self.report_job_error(run_job_info, msg=str(error))
            except Exception as error:
                self.report_job_error(
                    run_job_info,
                    msg=f"Failed to execute async run job: {error}",
                )
            else:
                started_at = self._async_run_submitted_at.get(run_id)
                duration = None
                if started_at is not None:
                    duration = max(0.0, time.perf_counter() - started_at)
                self._ensure_shell_benchmark_files(run_job_info.job, running_time_s=duration)
                self.report_job_success(run_job_info)
            self._debug_log(
                f"run-task complete id={run_id} done={run_task.done()} cancelled={run_task.cancelled()} job_key={self._job_key(run_job_info.job)}"
            )

        for completed_id in completed_ids:
            self._async_shell_jobs.pop(completed_id, None)
            self._async_shell_submitted_at.pop(completed_id, None)
        for completed_run_id in completed_run_ids:
            self._async_run_jobs.pop(completed_run_id, None)
            self._async_run_submitted_at.pop(completed_run_id, None)

        self._debug_log(
            f"post-complete shell_remaining={list(self._async_shell_jobs.keys())} run_remaining={list(self._async_run_jobs.keys())} completed_ids={list(completed_ids)} completed_job_keys={list(completed_job_keys)}"
        )

        yielded = 0
        for active_job_info in active_job_infos:
            active_job_key = self._job_key(active_job_info.job)
            if active_job_key in completed_job_keys:
                self._debug_log(f"skip active key={active_job_key} reason=completed")
                continue

            maybe_shell_id = None
            for shell_id, shell_job_info in self._async_shell_jobs.items():
                if self._job_key(shell_job_info.job) == active_job_key:
                    maybe_shell_id = shell_id
                    break

            maybe_run_id = None
            for run_id, (run_job_info, run_task) in self._async_run_jobs.items():
                if self._job_key(run_job_info.job) == active_job_key:
                    if run_task.done():
                        maybe_run_id = None
                    else:
                        maybe_run_id = run_id
                    break

            if maybe_shell_id is None and maybe_run_id is None:
                self._debug_log(
                    f"yield active key={active_job_key} reason=not-tracked shell_id=None run_id=None"
                )
                yield active_job_info
                yielded += 1
                continue
            if maybe_shell_id in completed_ids:
                self._debug_log(
                    f"skip active key={active_job_key} reason=shell-completed shell_id={maybe_shell_id}"
                )
                continue

            self._debug_log(
                f"yield active key={active_job_key} shell_id={maybe_shell_id} run_id={maybe_run_id}"
            )
            yield active_job_info
            yielded += 1

        self._debug_log(
            f"poll end cursor={self._job_update_cursor} yielded={yielded} active_in={len(active_job_infos)} shell_jobs={len(self._async_shell_jobs)} run_jobs={len(self._async_run_jobs)}"
        )

    def cancel_jobs(self, active_jobs):
        active_job_keys = {self._job_key(active_job_info.job) for active_job_info in active_jobs}
        shell_ids_to_cancel: list[str] = []
        run_ids_to_cancel: list[str] = []
        for shell_id, shell_job_info in list(self._async_shell_jobs.items()):
            if self._job_key(shell_job_info.job) in active_job_keys:
                shell_ids_to_cancel.append(shell_id)

        for run_id, (run_job_info, _run_task) in list(self._async_run_jobs.items()):
            if self._job_key(run_job_info.job) in active_job_keys:
                run_ids_to_cancel.append(run_id)

        if shell_ids_to_cancel:
            try:
                from js import cancelSnakemakeAsyncJobs

                cancelSnakemakeAsyncJobs(shell_ids_to_cancel)
            except Exception:
                pass
            for shell_id in shell_ids_to_cancel:
                self._async_shell_jobs.pop(shell_id, None)
                self._async_shell_submitted_at.pop(shell_id, None)

        for run_id in run_ids_to_cancel:
            run_item = self._async_run_jobs.pop(run_id, None)
            self._async_run_submitted_at.pop(run_id, None)
            if run_item is None:
                continue
            _, run_task = run_item
            run_task.cancel()
        return None

    def shutdown(self):
        if self._async_shell_jobs:
            try:
                from js import cancelSnakemakeAsyncJobs

                cancelSnakemakeAsyncJobs(list(self._async_shell_jobs.keys()))
            except Exception:
                pass
            self._async_shell_jobs.clear()
            self._async_shell_submitted_at.clear()

        if self._async_run_jobs:
            for _run_id, (_job_info, run_task) in list(self._async_run_jobs.items()):
                run_task.cancel()
            self._async_run_jobs.clear()
            self._async_run_submitted_at.clear()
        return None

    def cancel(self):
        return None