"""Runtime configuration, all overridable by environment variable."""

from __future__ import annotations

import os
from pathlib import Path


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser().resolve() if raw else default


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = _env_path("RESHOOT_DATA_DIR", ROOT / "data")
PROJECTS_DIR = DATA_DIR / "projects"

# Largest edge the working copy of the photo is resized to.  The original is
# always kept; heavy passes run on the working copy.
WORKING_MAX_EDGE = int(os.environ.get("RESHOOT_WORKING_MAX_EDGE", "1600"))
# Resolution the depth network and the proxy fit run at.
DEPTH_MAX_EDGE = int(os.environ.get("RESHOOT_DEPTH_MAX_EDGE", "700"))

# Depth backend: "auto" tries Depth Anything V2 then falls back to the
# camera-derived room box.  "planar" forces the fallback, "off" disables depth.
DEPTH_BACKEND = os.environ.get("RESHOOT_DEPTH_BACKEND", "auto")
DEPTH_MODEL = os.environ.get("RESHOOT_DEPTH_MODEL", "depth-anything/Depth-Anything-V2-Small-hf")

# Human mesh recovery: "auto" tries 4D-Humans/HMR2.0, then a torchvision
# keypoint detector, then leaves it to the manual box tool in the UI.
HUMANS_BACKEND = os.environ.get("RESHOOT_HUMANS_BACKEND", "auto")
HMR2_CHECKPOINT = os.environ.get("RESHOOT_HMR2_CHECKPOINT", "")

# Generation backend for step 6: "auto" (diffusers if installed, else the
# AUTOMATIC1111 API if reachable, else the proxy re-projection), "diffusers",
# "a1111", or "none".
GEN_BACKEND = os.environ.get("RESHOOT_GEN_BACKEND", "auto")
GEN_MODEL = os.environ.get("RESHOOT_GEN_MODEL", "stabilityai/stable-diffusion-2-1-base")
GEN_CONTROLNET_DEPTH = os.environ.get(
    "RESHOOT_GEN_CONTROLNET_DEPTH", "thibaud/controlnet-sd21-depth-diffusers"
)
GEN_CONTROLNET_NORMAL = os.environ.get("RESHOOT_GEN_CONTROLNET_NORMAL", "")
A1111_URL = os.environ.get("RESHOOT_A1111_URL", "http://127.0.0.1:7860")

TORCH_DEVICE = os.environ.get("RESHOOT_TORCH_DEVICE", "")

MAX_UPLOAD_BYTES = int(os.environ.get("RESHOOT_MAX_UPLOAD_BYTES", str(40 * 1024 * 1024)))
JOB_WORKERS = int(os.environ.get("RESHOOT_JOB_WORKERS", "2"))


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
