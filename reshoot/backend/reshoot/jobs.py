"""A tiny in-process job queue.

Every heavy pass (depth, proxy fitting, human recovery, generation) runs here on
a worker thread so the HTTP API stays responsive and the UI can poll progress
instead of blocking.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import JOB_WORKERS


class JobCancelled(Exception):
    """Raised inside a job body when the client cancelled it."""


@dataclass
class Job:
    id: str
    kind: str
    project_id: str
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "projectId": self.project_id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "result": self.result,
            "error": self.error,
            "createdAt": self.created_at,
            "finishedAt": self.finished_at,
        }


class Reporter:
    """Handed to job bodies so they can publish progress and honour cancellation."""

    def __init__(self, job: Job) -> None:
        self._job = job

    def __call__(self, progress: float, message: str = "") -> None:
        if self._job._cancel.is_set():
            raise JobCancelled()
        self._job.progress = max(0.0, min(1.0, float(progress)))
        if message:
            self._job.message = message

    @property
    def cancelled(self) -> bool:
        return self._job._cancel.is_set()


class JobManager:
    def __init__(self, workers: int = JOB_WORKERS) -> None:
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="reshoot-job")
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def submit(
        self,
        kind: str,
        project_id: str,
        fn: Callable[[Reporter], Any],
    ) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, project_id=project_id)
        with self._lock:
            self._jobs[job.id] = job
            self._prune_locked()
        self._pool.submit(self._run, job, fn)
        return job

    def _run(self, job: Job, fn: Callable[[Reporter], Any]) -> None:
        if job._cancel.is_set():
            job.status = "cancelled"
            job.finished_at = time.time()
            return
        job.status = "running"
        report = Reporter(job)
        try:
            job.result = fn(report)
            job.status = "done"
            job.progress = 1.0
            if not job.message:
                job.message = "Done"
        except JobCancelled:
            job.status = "cancelled"
            job.message = "Cancelled"
        except Exception as exc:  # surfaced to the UI, full trace to the log
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.message = "Failed"
            traceback.print_exc()
        finally:
            job.finished_at = time.time()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None or job.status in ("done", "error", "cancelled"):
            return False
        job._cancel.set()
        return True

    def for_project(self, project_id: str) -> list[Job]:
        with self._lock:
            return [j for j in self._jobs.values() if j.project_id == project_id]

    def _prune_locked(self, keep: int = 200) -> None:
        if len(self._jobs) <= keep:
            return
        done = sorted(
            (j for j in self._jobs.values() if j.finished_at is not None),
            key=lambda j: j.finished_at or 0.0,
        )
        for job in done[: len(self._jobs) - keep]:
            self._jobs.pop(job.id, None)


jobs = JobManager()
