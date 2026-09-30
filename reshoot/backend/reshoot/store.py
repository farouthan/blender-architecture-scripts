"""Project persistence.

Everything the user confirms is written to disk under ``data/projects/<id>/``
so that stepping backwards never recomputes anything: the confirmed solve, the
depth map, the proxy primitives and the bodies are all reloaded as-is.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import PROJECTS_DIR, ensure_dirs

STATE_FILE = "project.json"

# The pipeline stages, in order.  Confirming a stage invalidates everything
# downstream of it, because the downstream results were derived from it.
STEPS = ["upload", "solve", "proxy", "bodies", "navigate", "render"]
DOWNSTREAM: dict[str, list[str]] = {
    "solve": ["proxy", "bodies", "shots"],
    "proxy": ["bodies", "shots"],
    "bodies": ["shots"],
}


class ProjectError(Exception):
    pass


class NotFound(ProjectError):
    pass


_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(project_id: str) -> threading.RLock:
    with _locks_guard:
        return _locks.setdefault(project_id, threading.RLock())


def project_dir(project_id: str) -> Path:
    safe = "".join(ch for ch in project_id if ch.isalnum() or ch in "-_")
    if not safe or safe != project_id:
        raise NotFound(f"unknown project {project_id!r}")
    return PROJECTS_DIR / safe


def _atomic_write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=False))
    tmp.replace(path)


def create(image_bytes: bytes, filename: str, width: int, height: int) -> dict:
    ensure_dirs()
    pid = uuid.uuid4().hex[:12]
    d = project_dir(pid)
    (d / "renders").mkdir(parents=True, exist_ok=True)
    suffix = Path(filename).suffix.lower() or ".jpg"
    if suffix not in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"):
        suffix = ".jpg"
    (d / f"original{suffix}").write_bytes(image_bytes)
    state = {
        "id": pid,
        "createdAt": time.time(),
        "updatedAt": time.time(),
        "step": "solve",
        "image": {
            "filename": filename,
            "file": f"original{suffix}",
            "width": width,
            "height": height,
        },
        "solve": None,
        "proxy": None,
        "bodies": None,
        "shots": [],
    }
    _atomic_write_json(d / STATE_FILE, state)
    return state


def load(project_id: str) -> dict:
    path = project_dir(project_id) / STATE_FILE
    if not path.exists():
        raise NotFound(f"unknown project {project_id!r}")
    with _lock_for(project_id):
        return json.loads(path.read_text())


def save(state: dict) -> dict:
    pid = state["id"]
    state["updatedAt"] = time.time()
    with _lock_for(pid):
        _atomic_write_json(project_dir(pid) / STATE_FILE, state)
    return state


def update(project_id: str, mutate) -> dict:
    """Read-modify-write a project under its lock."""
    with _lock_for(project_id):
        state = load(project_id)
        result = mutate(state)
        if result is not None:
            state = result
        return save(state)


def invalidate_downstream(state: dict, stage: str) -> list[str]:
    """Clear results derived from ``stage``.  Returns what was cleared."""
    cleared: list[str] = []
    for key in DOWNSTREAM.get(stage, []):
        if key == "shots":
            if state.get("shots"):
                state["shots"] = []
                cleared.append("shots")
        elif state.get(key) is not None:
            state[key] = None
            cleared.append(key)
    return cleared


def asset_path(project_id: str, name: str) -> Path:
    """Resolve a project-relative asset path, refusing anything outside it."""
    base = project_dir(project_id).resolve()
    target = (base / name).resolve()
    if base != target and base not in target.parents:
        raise NotFound(f"bad asset path {name!r}")
    return target


def write_asset(project_id: str, name: str, data: bytes) -> str:
    path = asset_path(project_id, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def list_projects(limit: int = 50) -> list[dict]:
    ensure_dirs()
    out: list[dict] = []
    for d in sorted(PROJECTS_DIR.iterdir(), key=lambda p: -p.stat().st_mtime):
        state_file = d / STATE_FILE
        if not state_file.is_file():
            continue
        try:
            state = json.loads(state_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            {
                "id": state["id"],
                "step": state.get("step"),
                "createdAt": state.get("createdAt"),
                "updatedAt": state.get("updatedAt"),
                "image": state.get("image"),
                "hasSolve": state.get("solve") is not None,
                "hasProxy": state.get("proxy") is not None,
                "hasBodies": state.get("bodies") is not None,
                "shots": len(state.get("shots") or []),
            }
        )
        if len(out) >= limit:
            break
    return out


def delete(project_id: str) -> None:
    d = project_dir(project_id)
    if d.exists():
        shutil.rmtree(d)
