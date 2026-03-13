import asyncio
import sys
import types

from snakemake_interface_executor_plugins.executors.base import SubmittedJobInfo

from snakemake_executor_plugin_wasm import Executor


class FakeTask:
    def __init__(self, *, result_value=None, error=None, done=True):
        self._result_value = result_value
        self._error = error
        self._done = done
        self.cancelled = False

    def done(self):
        return self._done

    def result(self):
        if self._error is not None:
            raise self._error
        return self._result_value

    def cancel(self):
        self.cancelled = True


class FakeJob:
    def __init__(self, name: str):
        self.name = name


def make_executor():
    executor = Executor.__new__(Executor)
    executor._async_shell_jobs = {}
    executor._async_run_jobs = {}
    executor._warned_sync_run_parallel_limit = False
    executor._run_job_counter = 0

    success_reports = []
    error_reports = []

    def report_job_success(job_info):
        success_reports.append(job_info)

    def report_job_error(job_info, msg=""):
        error_reports.append((job_info, msg))

    executor.report_job_success = report_job_success
    executor.report_job_error = report_job_error
    executor._materialize_synced_files = lambda files: None

    return executor, success_reports, error_reports


async def collect_async_iter(async_iterable):
    items = []
    async for item in async_iterable:
        items.append(item)
    return items


def test_check_active_jobs_keeps_untracked_jobs(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "js",
        types.SimpleNamespace(pollSnakemakeAsyncJobUpdates=lambda: []),
    )

    executor, _, _ = make_executor()
    tracked_job_info = SubmittedJobInfo(job=FakeJob("tracked-shell"))
    untracked_job_info = SubmittedJobInfo(job=FakeJob("untracked"))

    executor._async_shell_jobs = {"shell-1": tracked_job_info}

    active_jobs = [tracked_job_info, untracked_job_info]
    yielded = asyncio.run(collect_async_iter(executor.check_active_jobs(active_jobs)))

    assert tracked_job_info in yielded
    assert untracked_job_info in yielded


def test_check_active_jobs_reports_completed_async_run_job(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "js",
        types.SimpleNamespace(pollSnakemakeAsyncJobUpdates=lambda: []),
    )

    executor, success_reports, error_reports = make_executor()
    run_job_info = SubmittedJobInfo(job=FakeJob("run-job"))
    executor._async_run_jobs = {
        "run-1": (run_job_info, FakeTask(result_value=None, done=True))
    }

    yielded = asyncio.run(collect_async_iter(executor.check_active_jobs([run_job_info])))

    assert yielded == []
    assert success_reports == [run_job_info]
    assert error_reports == []
    assert executor._async_run_jobs == {}


def test_cancel_jobs_cancels_matching_async_run_tasks():
    executor, _, _ = make_executor()

    job_info_1 = SubmittedJobInfo(job=FakeJob("run-job-1"))
    job_info_2 = SubmittedJobInfo(job=FakeJob("run-job-2"))

    task_1 = FakeTask(done=False)
    task_2 = FakeTask(done=False)

    executor._async_run_jobs = {
        "run-1": (job_info_1, task_1),
        "run-2": (job_info_2, task_2),
    }

    executor.cancel_jobs([job_info_1])

    assert task_1.cancelled is True
    assert task_2.cancelled is False
    assert "run-1" not in executor._async_run_jobs
    assert "run-2" in executor._async_run_jobs
