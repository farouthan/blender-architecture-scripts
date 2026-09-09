"""Automatic line-segment and vanishing-point detection.

Pure numpy/scipy so the first-pass solve works with no ML stack installed.  The
result only has to be close enough that the user can nudge the four fSpy axis
lines into place rather than drawing them from scratch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from skimage import feature, transform

from .geometry import focal_from_vanishing_points, line_from_points

# Segments shorter than this fraction of the image diagonal are noise.
MIN_SEGMENT_FRACTION = 0.035
# A segment votes for a vanishing point if its line passes this close to it,
# measured as the angle between the segment and the segment->VP direction.
VOTE_ANGLE_DEG = 1.6


@dataclass
class Segment:
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)

    @property
    def midpoint(self) -> np.ndarray:
        return np.array([(self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0])

    @property
    def direction(self) -> np.ndarray:
        d = np.array([self.x2 - self.x1, self.y2 - self.y1])
        n = float(np.linalg.norm(d))
        return d / n if n > 1e-9 else np.array([1.0, 0.0])

    def as_pair(self) -> list[list[float]]:
        return [[self.x1, self.y1], [self.x2, self.y2]]


def detect_segments(gray: np.ndarray, max_segments: int = 900) -> list[Segment]:
    """Extract straight edge segments with Canny + probabilistic Hough.

    Canny thins each edge to a single pixel run, which keeps the two sides of a
    drawn line from being merged, and the Hough pass tolerates the crossings
    that a connected-component grouping trips over.
    """
    gray = np.asarray(gray, dtype=np.float64)
    if gray.max() > 1.0:
        gray = gray / 255.0
    diag = math.hypot(*gray.shape)
    min_len = max(12.0, MIN_SEGMENT_FRACTION * diag)

    edges = feature.canny(gray, sigma=1.6, low_threshold=0.06, high_threshold=0.18)
    if edges.sum() < 40:
        edges = feature.canny(gray, sigma=1.0, low_threshold=0.02, high_threshold=0.08)
    if edges.sum() < 20:
        return []

    lines = transform.probabilistic_hough_line(
        edges,
        threshold=max(8, int(min_len * 0.35)),
        line_length=int(min_len),
        line_gap=max(3, int(diag * 0.006)),
        rng=0,
    )
    segments = [
        Segment(float(p0[0]), float(p0[1]), float(p1[0]), float(p1[1])) for p0, p1 in lines
    ]
    segments = [s for s in segments if s.length >= min_len]
    segments.sort(key=lambda s: -s.length)
    return segments[:max_segments]


def _vote(segments: list[Segment], vp: np.ndarray, tol_cos: float) -> np.ndarray:
    """Per-segment consistency with a candidate vanishing point (0 = no vote)."""
    mids = np.stack([s.midpoint for s in segments])
    dirs = np.stack([s.direction for s in segments])
    to_vp = vp[None, :] - mids
    norms = np.linalg.norm(to_vp, axis=1, keepdims=True)
    to_vp = np.divide(to_vp, np.maximum(norms, 1e-9))
    cos = np.abs(np.sum(to_vp * dirs, axis=1))
    lengths = np.array([s.length for s in segments])
    return np.where(cos > tol_cos, lengths, 0.0)


def find_vanishing_points(
    segments: list[Segment],
    width: int,
    height: int,
    max_points: int = 3,
    iterations: int = 2500,
    seed: int = 0,
) -> list[tuple[np.ndarray, float, list[int]]]:
    """RANSAC vanishing points, strongest first.

    Returns ``(point, score, member_indices)`` per vanishing point, where the
    score is the total inlier segment length.
    """
    if len(segments) < 4:
        return []
    rng = np.random.default_rng(seed)
    diag = math.hypot(width, height)
    tol_cos = math.cos(math.radians(VOTE_ANGLE_DEG))
    remaining = list(range(len(segments)))
    results: list[tuple[np.ndarray, float, list[int]]] = []

    for _ in range(max_points):
        if len(remaining) < 4:
            break
        pool = [segments[i] for i in remaining]
        lines = np.stack([line_from_points((s.x1, s.y1), (s.x2, s.y2)) for s in pool])
        weights = np.array([s.length for s in pool])
        probs = weights / weights.sum()

        best_vp: np.ndarray | None = None
        best_score = 0.0
        for _ in range(iterations):
            i, j = rng.choice(len(pool), size=2, replace=False, p=probs)
            p = np.cross(lines[i], lines[j])
            if abs(p[2]) < 1e-9:
                continue
            vp = p[:2] / p[2]
            if not np.isfinite(vp).all() or float(np.linalg.norm(vp)) > 60.0 * diag:
                continue
            score = float(_vote(pool, vp, tol_cos).sum())
            if score > best_score:
                best_score, best_vp = score, vp

        if best_vp is None or best_score < 2.0 * MIN_SEGMENT_FRACTION * diag:
            break

        votes = _vote(pool, best_vp, tol_cos)
        member_local = np.nonzero(votes > 0)[0]
        if len(member_local) < 2:
            break
        # Refine: least squares point closest to all inlier lines.
        A = lines[member_local]
        w = weights[member_local][:, None]
        M = (A * w).T @ A
        _, _, vt = np.linalg.svd(M)
        h = vt[-1]
        if abs(h[2]) > 1e-12:
            refined = h[:2] / h[2]
            if np.isfinite(refined).all() and float(np.linalg.norm(refined)) < 60.0 * diag:
                best_vp = refined

        members = [remaining[k] for k in member_local]
        results.append((best_vp, best_score, members))
        member_set = set(members)
        remaining = [i for i in remaining if i not in member_set]

    results.sort(key=lambda r: -r[1])
    return results


def pick_orthogonal_pair(
    candidates: list[tuple[np.ndarray, float, list[int]]],
    width: int,
    height: int,
) -> tuple[tuple[np.ndarray, list[int]], tuple[np.ndarray, list[int]]] | None:
    """Choose the two vanishing points that make the most plausible camera.

    Scores every pair by whether it yields a real focal length in a sane range
    and how much segment support it has.
    """
    principal = (width / 2.0, height / 2.0)
    diag = math.hypot(width, height)
    best = None
    best_score = -math.inf
    for a in range(len(candidates)):
        for b in range(a + 1, len(candidates)):
            vp_a, score_a, mem_a = candidates[a]
            vp_b, score_b, mem_b = candidates[b]
            focal = focal_from_vanishing_points(vp_a, vp_b, principal)
            if focal is None:
                continue
            # Plausible focal lengths for real photographs, in pixels.
            if not (0.25 * diag < focal < 4.0 * diag):
                continue
            support = (score_a + score_b) / diag
            # Prefer the pair whose focal implies an ordinary field of view.
            fov = math.degrees(2.0 * math.atan(height / (2.0 * focal)))
            fov_penalty = abs(math.log(max(fov, 1.0) / 45.0))
            total = support - 2.0 * fov_penalty
            if total > best_score:
                best_score = total
                best = ((vp_a, mem_a), (vp_b, mem_b))
    return best


def control_lines_for_vp(
    vp: np.ndarray, members: list[int], segments: list[Segment]
) -> list[list[list[float]]]:
    """Two representative fSpy control lines for a vanishing point.

    Picks the two longest supporting segments that are well separated in angle
    about the vanishing point, so dragging either one is meaningful.
    """
    if not members:
        return []
    chosen = sorted(members, key=lambda i: -segments[i].length)
    first = segments[chosen[0]]
    best_second = None
    best_sep = -1.0
    d1 = first.direction
    for i in chosen[1:]:
        sep = 1.0 - abs(float(np.dot(d1, segments[i].direction)))
        sep *= math.log1p(segments[i].length)
        if sep > best_sep:
            best_sep, best_second = sep, segments[i]
    lines = [first.as_pair()]
    if best_second is not None:
        lines.append(best_second.as_pair())
    return lines


def default_control_lines(width: int, height: int) -> dict:
    """A neutral one-point-perspective starting guess when detection finds nothing."""
    w, h = float(width), float(height)
    return {
        "axisA": [
            [[0.12 * w, 0.72 * h], [0.46 * w, 0.60 * h]],
            [[0.12 * w, 0.92 * h], [0.46 * w, 0.74 * h]],
        ],
        "axisB": [
            [[0.88 * w, 0.72 * h], [0.54 * w, 0.60 * h]],
            [[0.88 * w, 0.92 * h], [0.54 * w, 0.74 * h]],
        ],
        "origin": [0.5 * w, 0.82 * h],
    }


def auto_solve_control_points(gray: np.ndarray, width: int, height: int) -> dict:
    """Detect axis lines for the fSpy UI.  Always returns something usable."""
    scale = width / gray.shape[1]
    segments = detect_segments(gray)
    for s in segments:
        s.x1 *= scale
        s.y1 *= scale
        s.x2 *= scale
        s.y2 *= scale
    candidates = find_vanishing_points(segments, width, height)
    pair = pick_orthogonal_pair(candidates, width, height)
    if pair is None:
        result = default_control_lines(width, height)
        result["auto"] = False
        result["segmentCount"] = len(segments)
        return result

    (vp_a, mem_a), (vp_b, mem_b) = pair
    lines_a = control_lines_for_vp(vp_a, mem_a, segments)
    lines_b = control_lines_for_vp(vp_b, mem_b, segments)
    if len(lines_a) < 2 or len(lines_b) < 2:
        result = default_control_lines(width, height)
        result["auto"] = False
        result["segmentCount"] = len(segments)
        return result

    # Put the left-leaning vanishing point first so the UI colours are stable.
    if vp_a[0] > vp_b[0]:
        lines_a, lines_b = lines_b, lines_a

    return {
        "axisA": lines_a,
        "axisB": lines_b,
        "origin": [width / 2.0, height * 0.82],
        "auto": True,
        "segmentCount": len(segments),
    }
