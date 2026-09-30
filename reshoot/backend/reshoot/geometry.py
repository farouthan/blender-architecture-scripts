"""Pinhole camera geometry for the fSpy-style perspective solve.

Conventions, fixed once and used everywhere (backend and frontend agree):

* Image pixels: ``u`` to the right in ``[0, W]``, ``v`` downwards in ``[0, H]``.
* Camera space: OpenGL / three.js. ``x`` right, ``y`` up, looking down ``-z``.
* World space: ``y`` up, the ground plane is ``y == 0``.
* ``R`` is the world -> camera rotation, so ``p_cam = R @ (p_world - C)`` and the
  columns of ``R`` are the world axes expressed in camera space.  ``R.T`` is the
  camera -> world rotation that three.js wants on the camera object.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Iterable, Sequence

import numpy as np

Vec2 = Sequence[float]
Vec3 = Sequence[float]

# A vanishing point further away than this many image diagonals is treated as
# lying at infinity (the corresponding pencil of lines is parallel).
INFINITE_VP_DIAGONALS = 1e4


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        raise ValueError("cannot normalise a zero-length vector")
    return v / n


def line_from_points(a: Vec2, b: Vec2) -> np.ndarray:
    """Homogeneous line through two image points."""
    p = np.array([a[0], a[1], 1.0])
    q = np.array([b[0], b[1], 1.0])
    return np.cross(p, q)


def intersect_lines(l1: np.ndarray, l2: np.ndarray) -> np.ndarray | None:
    """Intersection of two homogeneous lines, or ``None`` when (near) parallel."""
    p = np.cross(l1, l2)
    if abs(p[2]) < 1e-9:
        return None
    return p[:2] / p[2]


def vanishing_point(
    seg_a: tuple[Vec2, Vec2], seg_b: tuple[Vec2, Vec2], diagonal: float
) -> np.ndarray | None:
    """Vanishing point of two image segments, or ``None`` if effectively at infinity."""
    p = intersect_lines(
        line_from_points(*seg_a),
        line_from_points(*seg_b),
    )
    if p is None:
        return None
    if float(np.linalg.norm(p)) > INFINITE_VP_DIAGONALS * diagonal:
        return None
    return p


@dataclass
class Camera:
    """A solved pinhole camera, in pixels and metres."""

    width: int
    height: int
    focal_px: float
    principal_point: tuple[float, float]
    # world -> camera rotation, row-major 3x3
    rotation: tuple[float, ...]
    position: tuple[float, float, float]

    @property
    def R(self) -> np.ndarray:
        return np.asarray(self.rotation, dtype=float).reshape(3, 3)

    @property
    def C(self) -> np.ndarray:
        return np.asarray(self.position, dtype=float)

    @property
    def vfov_deg(self) -> float:
        return math.degrees(2.0 * math.atan(self.height / (2.0 * self.focal_px)))

    @property
    def aspect(self) -> float:
        return self.width / self.height

    def ray(self, u: float, v: float) -> np.ndarray:
        """Unit world-space direction of the ray through pixel ``(u, v)``."""
        d_cam = pixel_ray_cam(u, v, self.principal_point, self.focal_px)
        return self.R.T @ d_cam

    def rays(self, uv: np.ndarray) -> np.ndarray:
        """Vectorised :meth:`ray` for an ``(N, 2)`` array of pixels."""
        cx, cy = self.principal_point
        d = np.stack(
            [
                uv[:, 0] - cx,
                -(uv[:, 1] - cy),
                np.full(len(uv), -self.focal_px),
            ],
            axis=1,
        )
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        return d @ self.R  # == (R.T @ d.T).T

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Project world points to pixels.

        Returns ``(uv, visible)`` where ``visible`` marks the points that are in
        front of the camera.  Pixels for points behind the camera are finite but
        meaningless, so callers must honour the mask.
        """
        pts = np.atleast_2d(np.asarray(points, dtype=float))
        cam = (pts - self.C) @ self.R.T
        z = cam[:, 2]
        visible = z < -1e-6
        denom = np.where(visible, -z, 1.0)
        cx, cy = self.principal_point
        u = cx + self.focal_px * cam[:, 0] / denom
        v = cy - self.focal_px * cam[:, 1] / denom
        return np.stack([u, v], axis=1), visible

    def ground_depth(self, uv: np.ndarray) -> np.ndarray:
        """View depth at which each pixel's ray meets the ground plane.

        ``NaN`` where the ray points at or above the horizon.
        """
        dirs = self.rays(np.atleast_2d(uv))
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -self.C[1] / dirs[:, 1]
        t = np.where(dirs[:, 1] < -1e-9, t, np.nan)
        # View depth is the component along the camera's forward axis.
        forward = -self.R[2]
        return t * (dirs @ forward)

    def horizon_y(self, u: float) -> float | None:
        """Image row of the horizon at column ``u`` (``None`` if the camera looks
        straight up or down and the horizon is not a graph over ``u``)."""
        # The horizon is the image of the plane y = 0 at infinity: directions d
        # with d.y == 0 project to it.
        d1 = self.R @ np.array([1.0, 0.0, 0.0])
        d2 = self.R @ np.array([0.0, 0.0, 1.0])
        cx, cy = self.principal_point

        def img(d: np.ndarray) -> np.ndarray | None:
            if abs(d[2]) < 1e-9:
                return None
            return np.array([cx + self.focal_px * d[0] / -d[2], cy - self.focal_px * d[1] / -d[2]])

        a, b = img(d1), img(d2)
        if a is None or b is None:
            return None
        if abs(b[0] - a[0]) < 1e-9:
            return None
        t = (u - a[0]) / (b[0] - a[0])
        return float(a[1] + t * (b[1] - a[1]))

    def to_dict(self) -> dict:
        d = asdict(self)
        d["vfovDeg"] = self.vfov_deg
        d["aspect"] = self.aspect
        # three.js consumes the camera -> world rotation directly.
        d["rotationCameraToWorld"] = tuple(self.R.T.reshape(-1).tolist())
        return d


def pixel_ray_cam(u: float, v: float, principal: Vec2, focal_px: float) -> np.ndarray:
    """Unit camera-space direction of the ray through pixel ``(u, v)``."""
    return _unit(np.array([u - principal[0], -(v - principal[1]), -focal_px]))


def focal_from_vanishing_points(
    vp1: Vec2, vp2: Vec2, principal: Vec2
) -> float | None:
    """Focal length in pixels implied by two orthogonal vanishing points.

    Returns ``None`` when the configuration is inconsistent, i.e. when the
    principal point does not fall inside the circle with the two vanishing
    points as diameter.  That happens while the user is still dragging lines
    into place, so callers keep the previous focal length and flag the solve.
    """
    fu = np.array([vp1[0] - principal[0], vp1[1] - principal[1]])
    fv = np.array([vp2[0] - principal[0], vp2[1] - principal[1]])
    f_sq = -float(np.dot(fu, fv))
    if f_sq <= 1.0:
        return None
    return math.sqrt(f_sq)


def rotation_from_vanishing_points(
    vp_a: Vec2, vp_b: Vec2, principal: Vec2, focal_px: float
) -> np.ndarray:
    """World -> camera rotation from two horizontal vanishing points.

    ``vp_a`` and ``vp_b`` are the vanishing points of two orthogonal horizontal
    axes.  Which one is labelled ``+x`` and which ``+z`` does not matter for the
    app -- only that ``y`` is up and the frame is right handed -- so the sign of
    the second axis is chosen to put world up on the up side of the image.
    """
    x_cam = pixel_ray_cam(vp_a[0], vp_a[1], principal, focal_px)
    z_cam = pixel_ray_cam(vp_b[0], vp_b[1], principal, focal_px)
    y_cam = _unit(np.cross(z_cam, x_cam))
    if y_cam[1] < 0.0:
        z_cam = -z_cam
        y_cam = _unit(np.cross(z_cam, x_cam))
    # Re-orthogonalise against accumulated float error.  The frame stays right
    # handed because each axis is rebuilt from the cross product of the other two.
    z_cam = _unit(np.cross(x_cam, y_cam))
    x_cam = _unit(np.cross(y_cam, z_cam))
    # Columns are the world axes in camera space.
    return np.stack([x_cam, y_cam, z_cam], axis=1)


def camera_position_from_origin(
    R: np.ndarray,
    origin_px: Vec2,
    principal: Vec2,
    focal_px: float,
    camera_height: float,
) -> np.ndarray | None:
    """Place the camera so the world origin sits under ``origin_px`` on the floor.

    Returns ``None`` when the origin pixel is on or above the horizon, where the
    ray never reaches the ground plane.
    """
    d_cam = pixel_ray_cam(origin_px[0], origin_px[1], principal, focal_px)
    d_world = R.T @ d_cam
    if d_world[1] > -1e-6:
        return None
    t = -camera_height / d_world[1]
    return -t * d_world


def solve_camera(
    width: int,
    height: int,
    vp_a: Vec2,
    vp_b: Vec2,
    origin_px: Vec2,
    camera_height: float,
    principal: Vec2 | None = None,
    fallback_focal_px: float | None = None,
) -> tuple[Camera | None, str | None]:
    """Full two-vanishing-point solve.  Returns ``(camera, error_message)``."""
    principal = tuple(principal) if principal is not None else (width / 2.0, height / 2.0)
    focal = focal_from_vanishing_points(vp_a, vp_b, principal)
    if focal is None:
        if fallback_focal_px is None:
            return None, (
                "The two axis directions are not consistent with a real camera. "
                "Drag the lines so they follow two perpendicular edges of the scene."
            )
        focal = fallback_focal_px
    R = rotation_from_vanishing_points(vp_a, vp_b, principal, focal)
    C = camera_position_from_origin(R, origin_px, principal, focal, camera_height)
    if C is None:
        return None, "Move the origin handle onto the floor, below the horizon line."
    cam = Camera(
        width=width,
        height=height,
        focal_px=float(focal),
        principal_point=(float(principal[0]), float(principal[1])),
        rotation=tuple(R.reshape(-1).tolist()),
        position=(float(C[0]), float(C[1]), float(C[2])),
    )
    return cam, None


def ground_grid_segments(
    cam: Camera, extent: float = 12.0, spacing: float = 1.0
) -> list[list[list[float]]]:
    """Ground-plane grid lines projected into the image, clipped to the frustum.

    Each entry is a polyline of pixel coordinates; lines that leave the front of
    the camera are split so nothing is drawn through the horizon.
    """
    segments: list[list[list[float]]] = []
    n = int(round(extent / spacing))
    coords = [i * spacing for i in range(-n, n + 1)]
    samples = 96
    ts = np.linspace(-extent, extent, samples)

    def add(points: np.ndarray) -> None:
        uv, visible = cam.project(points)
        run: list[list[float]] = []
        for (u, v), ok in zip(uv, visible):
            if ok and -4 * cam.width < u < 5 * cam.width and -4 * cam.height < v < 5 * cam.height:
                run.append([float(u), float(v)])
            elif len(run) > 1:
                segments.append(run)
                run = []
            else:
                run = []
        if len(run) > 1:
            segments.append(run)

    for c in coords:
        add(np.stack([np.full(samples, c), np.zeros(samples), ts], axis=1))
        add(np.stack([ts, np.zeros(samples), np.full(samples, c)], axis=1))
    return segments


def axis_segments(cam: Camera, length: float = 2.0) -> dict[str, list[list[float]]]:
    """The three world axes drawn from the origin, in pixels."""
    out: dict[str, list[list[float]]] = {}
    for name, direction in (("x", (1, 0, 0)), ("y", (0, 1, 0)), ("z", (0, 0, 1))):
        pts = np.stack([np.zeros(3), np.asarray(direction, dtype=float) * length])
        uv, visible = cam.project(pts)
        if bool(visible.all()):
            out[name] = uv.tolist()
    return out


def fit_scale_shift_to_ground(
    disparity: np.ndarray,
    target_depth: np.ndarray,
    iterations: int = 400,
    inlier_tol: float = 0.12,
    rng: np.random.Generator | None = None,
) -> tuple[float, float, float]:
    """Robustly fit ``depth = 1 / (s * disparity + t)`` to floor samples.

    ``disparity`` is the relative inverse depth from the monocular network and
    ``target_depth`` the view depth the solved ground plane predicts for the
    same pixels.  Only a fraction of the samples really are floor, so the fit is
    RANSAC over pairs.  Returns ``(s, t, inlier_fraction)``.
    """
    rng = rng or np.random.default_rng(0)
    d = np.asarray(disparity, dtype=float)
    z = np.asarray(target_depth, dtype=float)
    ok = np.isfinite(d) & np.isfinite(z) & (z > 1e-3)
    d, z = d[ok], z[ok]
    if len(d) < 8:
        return 1.0, 0.0, 0.0
    inv_z = 1.0 / z

    best = (1.0, 0.0, -1.0)
    n = len(d)
    for _ in range(iterations):
        i, j = rng.integers(0, n, 2)
        if abs(d[i] - d[j]) < 1e-6:
            continue
        s = (inv_z[i] - inv_z[j]) / (d[i] - d[j])
        t = inv_z[i] - s * d[i]
        if s <= 1e-9:
            continue
        pred = s * d + t
        good = pred > 1e-6
        if not good.any():
            continue
        rel = np.abs(1.0 / pred[good] - z[good]) / z[good]
        score = float((rel < inlier_tol).sum()) / n
        if score > best[2]:
            best = (float(s), float(t), score)

    s, t, frac = best
    if frac <= 0:
        # Degenerate input: fall back to a least-squares fit on inverse depth.
        A = np.stack([d, np.ones_like(d)], axis=1)
        sol, *_ = np.linalg.lstsq(A, inv_z, rcond=None)
        s, t = float(sol[0]), float(sol[1])
        return (s if s > 1e-9 else 1.0), t, 0.0

    # Polish on the inliers.
    pred = s * d + t
    good = pred > 1e-6
    rel = np.full(len(d), np.inf)
    rel[good] = np.abs(1.0 / pred[good] - z[good]) / z[good]
    mask = rel < inlier_tol
    if mask.sum() >= 8:
        A = np.stack([d[mask], np.ones(int(mask.sum()))], axis=1)
        sol, *_ = np.linalg.lstsq(A, inv_z[mask], rcond=None)
        if sol[0] > 1e-9:
            s, t = float(sol[0]), float(sol[1])
    return s, t, frac
