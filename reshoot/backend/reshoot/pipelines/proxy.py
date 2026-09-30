"""Turn a relative depth map into a metric proxy scene of primitive shapes.

The fit is the part the user cares about: the depth network only knows relative
inverse depth, so a scale and a shift are solved for by requiring the floor
pixels to land on the ground plane of the confirmed camera.  Everything standing
on that floor is then clustered and replaced by a box or a cylinder.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict

import numpy as np
from scipy import ndimage

from ..geometry import Camera, fit_scale_shift_to_ground

# Points closer to the floor than this are treated as floor, not furniture.
# Depth error grows with range, so the band widens with distance from the
# camera; without that, far floor pixels cluster into long flat slivers.
FLOOR_EPS = 0.06
FLOOR_EPS_PER_METRE = 0.012
# A cluster has to be at least this tall, and at least this big in two of its
# three dimensions, to be worth a primitive.
MIN_CLUSTER_HEIGHT = 0.12
MIN_CLUSTER_EXTENT = 0.15
MAX_RANGE = 30.0
MAX_HEIGHT = 6.0


@dataclass
class Primitive:
    id: str
    kind: str  # box | cylinder | plane
    position: tuple[float, float, float]
    size: tuple[float, float, float]
    rotationY: float
    label: str
    color: str
    source: str = "auto"
    hidden: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _rgb_hex(rgb: np.ndarray) -> str:
    r, g, b = (int(max(0, min(255, round(float(c))))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def unproject(
    cam: Camera, disparity: np.ndarray, scale: float, shift: float
) -> tuple[np.ndarray, np.ndarray]:
    """Metric world points for every depth pixel.

    Returns ``(points, valid)`` with ``points`` shaped ``(H*W, 3)``.
    """
    h, w = disparity.shape
    us = (np.arange(w) + 0.5) * (cam.width / w)
    vs = (np.arange(h) + 0.5) * (cam.height / h)
    uu, vv = np.meshgrid(us, vs)
    uv = np.stack([uu.ravel(), vv.ravel()], axis=1)
    dirs = cam.rays(uv)

    inv = scale * disparity.ravel() + shift
    valid = inv > 1e-4
    view_depth = np.where(valid, 1.0 / np.where(valid, inv, 1.0), np.nan)

    forward = -cam.R[2]
    cos = dirs @ forward
    valid &= cos > 1e-6
    t = np.where(valid, view_depth / np.where(valid, cos, 1.0), np.nan)
    points = cam.C[None, :] + t[:, None] * dirs
    valid &= np.isfinite(points).all(axis=1)
    valid &= t < MAX_RANGE
    return points, valid


def fit_to_ground(
    cam: Camera, disparity: np.ndarray, report=lambda *_: None
) -> tuple[float, float, float]:
    """Solve the scale and shift that put the floor pixels on the ground plane."""
    h, w = disparity.shape
    us = (np.arange(w) + 0.5) * (cam.width / w)
    vs = (np.arange(h) + 0.5) * (cam.height / h)
    uu, vv = np.meshgrid(us, vs)
    uv = np.stack([uu.ravel(), vv.ravel()], axis=1)

    report(0.15, "Finding the floor")
    ground = cam.ground_depth(uv)
    below_horizon = np.isfinite(ground) & (ground > 0) & (ground < MAX_RANGE)
    if below_horizon.sum() < 32:
        raise ValueError(
            "The solved camera sees almost no ground plane.  Go back and check "
            "the horizon and the origin handle."
        )

    # Sample the lower part of the frame, where floor is most likely.
    rows = np.repeat(np.arange(h), w)
    weight_rows = rows >= int(h * 0.35)
    candidate = np.nonzero(below_horizon & weight_rows)[0]
    if len(candidate) < 32:
        candidate = np.nonzero(below_horizon)[0]
    rng = np.random.default_rng(7)
    if len(candidate) > 20000:
        candidate = rng.choice(candidate, 20000, replace=False)

    report(0.35, "Fitting depth to the ground plane")
    s, t, frac = fit_scale_shift_to_ground(
        disparity.ravel()[candidate], ground[candidate], rng=rng
    )
    return s, t, frac


def _oriented_footprint(xz: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    """Minimum-area oriented rectangle of a footprint in the world XZ plane.

    Returns ``(centre, yaw, size_along_major, size_along_minor)``.  A sweep of
    candidate angles is plenty for a proxy box and avoids a convex-hull pass.

    ``yaw`` is in the three.js sense: rotating a mesh by ``rotation.y = yaw``
    lines its local ``+x`` up with the rectangle's major axis, and ``ext_a`` is
    the extent along it.  Rotating about
    ``+y`` sends local ``+x`` to world ``(cos yaw, 0, -sin yaw)``, so the yaw is
    the negative of the sweep angle, which measures from ``+x`` towards ``+z``.
    """
    centre = xz.mean(axis=0)
    centred = xz - centre
    best = (0.0, math.inf, 0.0, 0.0, centre)
    for angle in np.linspace(0.0, math.pi / 2.0, 46, endpoint=False):
        c, s = math.cos(angle), math.sin(angle)
        rot = np.array([[c, s], [-s, c]])
        local = centred @ rot.T
        lo, hi = local.min(axis=0), local.max(axis=0)
        ext = hi - lo
        area = float(ext[0] * ext[1])
        if area < best[1]:
            mid_local = (lo + hi) / 2.0
            mid = centre + mid_local @ rot
            best = (angle, area, float(ext[0]), float(ext[1]), mid)
    angle, _, ext_a, ext_b, mid = best
    yaw = -angle
    if ext_a < ext_b:
        # The sweep landed on the minor axis; name the major one first and turn
        # the yaw a quarter turn so local +x still points along it.
        ext_a, ext_b = ext_b, ext_a
        yaw += math.pi / 2.0
    return mid, yaw, ext_a, ext_b


def _classify(points: np.ndarray, ext_a: float, ext_b: float) -> str:
    """Box or cylinder, judged by how round the footprint is."""
    if min(ext_a, ext_b) < 1e-4:
        return "box"
    aspect = max(ext_a, ext_b) / min(ext_a, ext_b)
    if aspect > 1.35:
        return "box"
    xz = points[:, [0, 2]]
    centre = xz.mean(axis=0)
    r = np.linalg.norm(xz - centre, axis=1)
    radius = max(ext_a, ext_b) / 2.0
    if radius < 1e-4:
        return "box"
    # A filled circle has mean(r)/R = 2/3; a filled square is closer to 0.765.
    ratio = float(r.mean()) / radius
    return "cylinder" if ratio < 0.70 else "box"


def extract_primitives(
    cam: Camera,
    disparity: np.ndarray,
    scale: float,
    shift: float,
    colors: np.ndarray | None = None,
    voxel: float = 0.09,
    report=lambda *_: None,
) -> tuple[list[Primitive], dict]:
    """Cluster the metric point cloud into furniture-sized primitives."""
    report(0.55, "Unprojecting the depth map")
    points, valid = unproject(cam, disparity, scale, shift)
    flat_colors = None
    if colors is not None:
        flat_colors = colors.reshape(-1, 3)

    ground_range = np.linalg.norm(points - cam.C[None, :], axis=1)
    floor_band = FLOOR_EPS + FLOOR_EPS_PER_METRE * np.nan_to_num(ground_range, nan=0.0)
    above = valid & (points[:, 1] > floor_band) & (points[:, 1] < MAX_HEIGHT)
    floor_mask = valid & (np.abs(points[:, 1]) <= floor_band)

    stats = {
        "pixels": int(valid.sum()),
        "floorPixels": int(floor_mask.sum()),
        "objectPixels": int(above.sum()),
    }

    if above.sum() < 200:
        report(0.9, "No objects stood clear of the floor")
        return [_floor_plane(points[floor_mask])], stats

    obj = points[above]
    obj_colors = flat_colors[above] if flat_colors is not None else None

    # Ignore far-flung outliers so the voxel grid stays small.
    lo = np.percentile(obj, 1.0, axis=0)
    hi = np.percentile(obj, 99.0, axis=0)
    keep = np.all((obj >= lo - 0.5) & (obj <= hi + 0.5), axis=1)
    obj = obj[keep]
    if obj_colors is not None:
        obj_colors = obj_colors[keep]
    if len(obj) < 200:
        return [_floor_plane(points[floor_mask])], stats

    report(0.65, "Voxelising")
    origin = obj.min(axis=0)
    span = obj.max(axis=0) - origin
    # Cap the grid so a bad fit cannot blow up memory.
    while True:
        dims = np.maximum(np.ceil(span / voxel).astype(int) + 1, 1)
        if int(dims.prod()) <= 24_000_000 or voxel > 1.0:
            break
        voxel *= 1.5
    idx = np.floor((obj - origin) / voxel).astype(int)
    idx = np.clip(idx, 0, dims - 1)
    grid = np.zeros(tuple(dims), dtype=bool)
    grid[idx[:, 0], idx[:, 1], idx[:, 2]] = True

    report(0.75, "Grouping objects")
    labels, count = ndimage.label(grid, structure=np.ones((3, 3, 3), dtype=int))
    stats["clusters"] = int(count)
    if count == 0:
        return [_floor_plane(points[floor_mask])], stats

    point_labels = labels[idx[:, 0], idx[:, 1], idx[:, 2]]
    primitives: list[Primitive] = [_floor_plane(points[floor_mask])]

    order = np.argsort(np.bincount(point_labels, minlength=count + 1)[1:])[::-1] + 1
    min_points = max(80, len(obj) // 400)
    for n, lab in enumerate(order[:24]):
        sel = point_labels == lab
        if sel.sum() < min_points:
            continue
        pts = obj[sel]
        y_lo, y_hi = float(np.percentile(pts[:, 1], 2.0)), float(np.percentile(pts[:, 1], 98.0))
        height = max(y_hi - y_lo, 0.05)
        mid, yaw, ext_a, ext_b = _oriented_footprint(pts[:, [0, 2]])
        # Reject floor slivers and paper-thin shards: a real object is tall
        # enough to stand on the floor and thick enough to be seen from a
        # second angle.
        if height < MIN_CLUSTER_HEIGHT:
            continue
        dims = sorted((ext_a, ext_b, height), reverse=True)
        if dims[1] < MIN_CLUSTER_EXTENT:
            continue
        kind = _classify(pts, ext_a, ext_b)
        if kind == "cylinder":
            diameter = (ext_a + ext_b) / 2.0
            size = (diameter, height, diameter)
        else:
            size = (max(ext_a, 0.05), height, max(ext_b, 0.05))
        colour = "#8a93a5"
        if obj_colors is not None:
            colour = _rgb_hex(obj_colors[sel].mean(axis=0))
        primitives.append(
            Primitive(
                id=f"prim-{n:03d}",
                kind=kind,
                position=(float(mid[0]), float(y_lo + height / 2.0), float(mid[1])),
                size=tuple(float(v) for v in size),
                rotationY=float(yaw),
                label=f"{kind} {n + 1}",
                color=colour,
            )
        )

    report(0.95, f"{len(primitives) - 1} objects")
    return primitives, stats


def _floor_plane(points: np.ndarray) -> Primitive:
    """A ground-plane slab sized to cover the visible floor."""
    if len(points) == 0:
        half = 8.0
        cx = cz = 0.0
    else:
        lo = np.percentile(points, 2.0, axis=0)
        hi = np.percentile(points, 98.0, axis=0)
        cx, cz = float((lo[0] + hi[0]) / 2.0), float((lo[2] + hi[2]) / 2.0)
        half = float(max(hi[0] - lo[0], hi[2] - lo[2]) / 2.0 + 1.0)
        half = min(max(half, 3.0), 40.0)
    return Primitive(
        id="floor",
        kind="plane",
        position=(cx, 0.0, cz),
        size=(half * 2.0, 0.0, half * 2.0),
        rotationY=0.0,
        label="floor",
        color="#3a4152",
        source="ground-plane",
    )
