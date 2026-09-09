#!/usr/bin/env python3
"""Regenerate the cross-language solve fixtures.

    python tests/generate_fixtures.py

Writes ../frontend/test/fixtures.json.  Both `pytest` and `npm test` assert
against it, so the browser preview and the canonical server solve cannot drift
apart unnoticed.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from reshoot.geometry import (
    ground_grid_segments,
    solve_camera,
    vanishing_point,
)

CASES = [
    {
        "name": "two-point interior",
        "width": 1600, "height": 1200,
        "controlPoints": {
            "axisA": [[[120, 880], [700, 742]], [[140, 1120], [720, 900]]],
            "axisB": [[[1480, 880], [900, 742]], [[1460, 1120], [880, 900]]],
            "origin": [800, 1000],
        },
        "cameraHeight": 1.6,
    },
    {
        "name": "wide angle, low camera",
        "width": 960, "height": 720,
        "controlPoints": {
            "axisA": [[[40, 520], [520, 470]], [[60, 690], [540, 600]]],
            "axisB": [[[920, 500], [430, 462]], [[900, 700], [420, 604]]],
            "origin": [470, 620],
        },
        "cameraHeight": 0.9,
    },
    {
        "name": "portrait, tall camera",
        "width": 900, "height": 1600,
        "controlPoints": {
            "axisA": [[[60, 1120], [520, 1020]], [[80, 1420], [540, 1210]]],
            "axisB": [[[860, 1100], [400, 1015]], [[840, 1440], [390, 1215]]],
            "origin": [450, 1300],
        },
        "cameraHeight": 2.4,
    },
]

PROJECT_POINTS = [
    [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
    [2.5, 0.8, -1.3], [-1.75, 1.9, 4.25],
]
GROUND_PIXEL_FRACTIONS = [[0.5, 0.9], [0.25, 0.8], [0.75, 0.95]]


def build() -> list[dict]:
    out = []
    for case in CASES:
        w, h = case["width"], case["height"]
        diag = math.hypot(w, h)
        control = case["controlPoints"]
        vp_a = vanishing_point(
            tuple(map(tuple, control["axisA"][0])), tuple(map(tuple, control["axisA"][1])), diag
        )
        vp_b = vanishing_point(
            tuple(map(tuple, control["axisB"][0])), tuple(map(tuple, control["axisB"][1])), diag
        )
        cam, err = solve_camera(w, h, vp_a, vp_b, tuple(control["origin"]), case["cameraHeight"])
        assert cam is not None, f"{case['name']}: {err}"

        uv, visible = cam.project(np.array(PROJECT_POINTS, dtype=float))
        ground = []
        for fx, fy in GROUND_PIXEL_FRACTIONS:
            u, v = fx * w, fy * h
            d = cam.ray(u, v)
            point = None
            if d[1] < -1e-9:
                t = -cam.C[1] / d[1]
                if t > 0:
                    point = (cam.C + t * d).tolist()
            ground.append({"pixel": [u, v], "point": point})

        grid = ground_grid_segments(cam, extent=6.0, spacing=2.0)
        out.append(
            {
                **case,
                "expected": {
                    "vanishingPoints": {"axisA": vp_a.tolist(), "axisB": vp_b.tolist()},
                    "camera": cam.to_dict(),
                    "projections": [
                        {"point": p, "uv": row.tolist(), "visible": bool(ok)}
                        for p, row, ok in zip(PROJECT_POINTS, uv, visible)
                    ],
                    "ground": ground,
                    "horizon": [cam.horizon_y(0.0), cam.horizon_y(float(w))],
                    "gridPolylineCount": len(grid),
                    "gridFirstPolyline": grid[0] if grid else None,
                },
            }
        )
    return out


def main() -> None:
    target = Path(__file__).resolve().parents[2] / "frontend" / "test" / "fixtures.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"cases": build()}, indent=2) + "\n")
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
