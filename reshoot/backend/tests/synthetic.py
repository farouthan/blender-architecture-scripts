"""A synthetic room photo with a known camera, used across the tests."""

from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from reshoot.geometry import Camera, solve_camera

TRUTH_BOXES = [
    ((-1.2, 0.0, 1.0), (0.6, 0.75, 2.6)),
    ((1.4, 0.0, -0.4), (2.6, 1.9, 0.8)),
]


def truth_camera(width: int = 960, height: int = 720) -> Camera:
    cam, err = solve_camera(width, height, (2600, 340), (-1500, 352), (480, 600), 1.6)
    assert cam is not None, err
    return cam


def render_wireframe(cam: Camera) -> Image.Image:
    """A grey room with drawn floor grid and wall edges, enough for line detection."""
    w, h = cam.width, cam.height
    img = np.full((h, w), 24.0, np.float32)

    def draw(p, q, value=235.0):
        (u1, v1), (u2, v2) = p, q
        n = int(max(abs(u2 - u1), abs(v2 - v1))) * 3 + 2
        for t in np.linspace(0, 1, n):
            u, v = u1 + (u2 - u1) * t, v1 + (v2 - v1) * t
            iu, iv = int(u), int(v)
            if 0 <= iv < h and 0 <= iu < w:
                img[iv, iu] = value

    segs = []
    for z in np.arange(-3, 7.01, 1.0):
        segs.append(((-4, 0, z), (6, 0, z)))
    for x in np.arange(-4, 6.01, 1.0):
        segs.append(((x, 0, -3), (x, 0, 7)))
    for x in (-4, -2, 0, 2, 4, 6):
        segs.append(((x, 0, 7), (x, 2.6, 7)))
    for z in (-3, -1, 1, 3, 5, 7):
        segs.append(((6, 0, z), (6, 2.6, z)))
    for lo, hi in TRUTH_BOXES:
        xs, ys, zs = zip(lo, hi)
        corners = [(x, y, z) for x in xs for y in ys for z in zs]
        for i, a in enumerate(corners):
            for b in corners[i + 1 :]:
                if sum(1 for p, q in zip(a, b) if p != q) == 1:
                    segs.append((a, b))

    for a, b in segs:
        uv, vis = cam.project(np.array([a, b], float))
        if vis.all():
            draw(uv[0], uv[1])
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).convert("RGB")


def render_depth(cam: Camera, dh: int = 180, dw: int = 240) -> np.ndarray:
    """Ground-truth disparity of the same room, normalised to [0, 1]."""
    us = (np.arange(dw) + 0.5) * (cam.width / dw)
    vs = (np.arange(dh) + 0.5) * (cam.height / dh)
    uu, vv = np.meshgrid(us, vs)
    dirs = cam.rays(np.stack([uu.ravel(), vv.ravel()], axis=1))
    C = cam.C

    with np.errstate(divide="ignore", invalid="ignore"):
        t = -C[1] / dirs[:, 1]
    t = np.where(dirs[:, 1] < -1e-9, t, np.inf)
    t = np.where(t > 0, t, np.inf)

    for lo, hi in TRUTH_BOXES:
        lo_a, hi_a = np.array(lo, float), np.array(hi, float)
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (lo_a - C) / dirs, (hi_a - C) / dirs
        tmin = np.nanmax(np.minimum(t1, t2), axis=1)
        tmax = np.nanmin(np.maximum(t1, t2), axis=1)
        hit = np.where(tmax >= np.maximum(tmin, 0), tmin, np.inf)
        t = np.minimum(t, np.where(hit > 0, hit, np.inf))

    t = np.where(np.isfinite(t), t, 60.0)
    view = t * (dirs @ -cam.R[2])
    disp = 1.0 / np.maximum(view, 0.1)
    disp = (disp - disp.min()) / (disp.max() - disp.min())
    return disp.reshape(dh, dw)


def photo_bytes(cam: Camera | None = None) -> bytes:
    cam = cam or truth_camera()
    buf = io.BytesIO()
    render_wireframe(cam).save(buf, format="PNG")
    return buf.getvalue()
