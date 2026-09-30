"""Monocular depth estimation.

Preferred backend is Depth Anything V2 through ``transformers``.  When no ML
stack is installed the module falls back to a geometric room box derived from
the confirmed camera: the floor comes straight from the solved ground plane and
the area above the horizon is filled with a back wall.  That fallback is
approximate but it is *correct where it matters* -- the floor -- so the rest of
the pipeline behaves the same either way.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .. import config
from ..geometry import Camera


@dataclass
class DepthResult:
    # Relative inverse depth (disparity): larger is nearer.  Normalised to [0, 1].
    disparity: np.ndarray
    backend: str
    note: str = ""

    @property
    def shape(self) -> tuple[int, int]:
        return self.disparity.shape  # type: ignore[return-value]


_pipe_cache: dict[str, object] = {}


def _load_depth_anything():
    """Return a transformers depth pipeline, or ``None`` if unavailable."""
    key = config.DEPTH_MODEL
    if key in _pipe_cache:
        return _pipe_cache[key]
    try:
        import torch  # noqa: F401
        from transformers import pipeline as hf_pipeline
    except Exception:
        _pipe_cache[key] = None
        return None
    try:
        import torch

        device = config.TORCH_DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")
        pipe = hf_pipeline("depth-estimation", model=key, device=device)
    except Exception:
        _pipe_cache[key] = None
        return None
    _pipe_cache[key] = pipe
    return pipe


def _normalise(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    lo, hi = float(np.nanmin(a)), float(np.nanmax(a))
    if not math.isfinite(lo) or not math.isfinite(hi) or hi - lo < 1e-9:
        return np.zeros_like(a)
    return (a - lo) / (hi - lo)


def planar_room_disparity(cam: Camera, width: int, height: int) -> np.ndarray:
    """Disparity of a plausible room box under the solved camera.

    Below the horizon every pixel lands on the ground plane.  Above it, pixels
    are put on a vertical back wall placed at the depth the floor reaches at the
    bottom of the frame, which keeps the two halves continuous at the horizon.
    """
    us = (np.arange(width) + 0.5) * (cam.width / width)
    vs = (np.arange(height) + 0.5) * (cam.height / height)
    uu, vv = np.meshgrid(us, vs)
    uv = np.stack([uu.ravel(), vv.ravel()], axis=1)

    depth = cam.ground_depth(uv).reshape(height, width)
    finite = np.isfinite(depth) & (depth > 0)
    if finite.any():
        # Clamp runaway depth near the horizon and reuse it as the wall distance.
        near_far = float(np.percentile(depth[finite], 96.0))
        wall = max(near_far, 2.0)
        depth = np.where(finite, np.minimum(depth, wall), wall)
    else:
        depth = np.full((height, width), 6.0)
    depth = np.maximum(depth, 0.15)
    return _normalise(1.0 / depth)


def estimate(
    image,
    cam: Camera,
    report=lambda *_: None,
    max_edge: int | None = None,
) -> DepthResult:
    """Estimate relative depth for a PIL image already matched to ``cam``."""
    from PIL import Image

    max_edge = max_edge or config.DEPTH_MAX_EDGE
    w, h = image.size
    scale = min(1.0, max_edge / max(w, h))
    tw, th = max(1, int(round(w * scale))), max(1, int(round(h * scale)))

    backend = config.DEPTH_BACKEND
    if backend in ("auto", "depth-anything"):
        report(0.1, "Loading Depth Anything V2")
        pipe = _load_depth_anything()
        if pipe is not None:
            report(0.25, "Running depth estimation")
            small = image.convert("RGB").resize((tw, th), Image.LANCZOS)
            out = pipe(small)
            raw = out.get("predicted_depth", out.get("depth"))
            arr = np.asarray(raw if not hasattr(raw, "cpu") else raw.squeeze().cpu().numpy())
            if arr.ndim == 3:
                arr = arr[0]
            if arr.shape != (th, tw):
                arr = np.asarray(
                    Image.fromarray(arr.astype(np.float32)).resize((tw, th), Image.BILINEAR)
                )
            report(0.85, "Normalising depth")
            return DepthResult(_normalise(arr), f"depth-anything:{config.DEPTH_MODEL}")
        if backend == "depth-anything":
            raise RuntimeError(
                "Depth Anything V2 was requested but transformers/torch are not "
                "installed.  Install backend/requirements-ml.txt or set "
                "RESHOOT_DEPTH_BACKEND=planar."
            )

    report(0.4, "Building a room box from the solved camera")
    disp = planar_room_disparity(cam, tw, th)
    return DepthResult(
        disp,
        "planar-room",
        "No depth network installed, so the proxy uses the solved ground plane "
        "and a back wall.  Add or edit primitives to fill in the furniture.",
    )


def to_png_bytes(disparity: np.ndarray) -> bytes:
    """16-bit greyscale PNG of the disparity, for inspection and re-use."""
    import io

    from PIL import Image

    a = np.clip(_normalise(disparity) * 65535.0, 0, 65535).astype(np.uint16)
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, format="PNG")
    return buf.getvalue()
