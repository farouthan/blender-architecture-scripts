import math

import numpy as np
import pytest

from reshoot.geometry import (
    Camera,
    fit_scale_shift_to_ground,
    focal_from_vanishing_points,
    ground_grid_segments,
    solve_camera,
    vanishing_point,
)
from synthetic import truth_camera


def test_solve_places_origin_under_the_handle():
    cam, err = solve_camera(1600, 1200, (2400, 600), (-800, 620), (800, 1000), 1.6)
    assert err is None and cam is not None
    uv, visible = cam.project(np.array([[0.0, 0.0, 0.0]]))
    assert visible[0]
    assert uv[0] == pytest.approx([800.0, 1000.0], abs=1e-6)
    assert cam.position[1] == pytest.approx(1.6)


def test_rotation_is_a_proper_rotation():
    cam = truth_camera()
    R = cam.R
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)
    assert float(np.linalg.det(R)) == pytest.approx(1.0, abs=1e-9)


def test_camera_height_scales_the_scene_linearly():
    a, _ = solve_camera(1600, 1200, (2400, 600), (-800, 620), (800, 1000), 1.6)
    b, _ = solve_camera(1600, 1200, (2400, 600), (-800, 620), (800, 1000), 3.2)
    assert np.allclose(np.asarray(b.position), 2.0 * np.asarray(a.position), atol=1e-9)
    assert b.focal_px == pytest.approx(a.focal_px)


def test_focal_rejects_inconsistent_vanishing_points():
    # Two vanishing points on the same side of the principal point cannot come
    # from orthogonal directions.
    assert focal_from_vanishing_points((900, 600), (1200, 601), (800, 600)) is None


def test_solve_reports_an_origin_above_the_horizon():
    cam, err = solve_camera(1600, 1200, (2400, 600), (-800, 620), (800, 100), 1.6)
    assert cam is None
    assert "horizon" in err


def test_projection_round_trips_through_the_ray():
    cam = truth_camera()
    pts = np.array([[1.0, 0.5, 3.0], [-2.0, 1.2, 5.0], [0.3, 0.0, 1.0]])
    uv, visible = cam.project(pts)
    assert visible.all()
    dirs = cam.rays(uv)
    expected = pts - cam.C
    expected /= np.linalg.norm(expected, axis=1, keepdims=True)
    assert np.allclose(dirs, expected, atol=1e-9)


def test_ground_depth_matches_a_manual_intersection():
    cam = truth_camera()
    target = np.array([2.0, 0.0, 3.0])
    uv, visible = cam.project(target[None, :])
    assert visible[0]
    depth = cam.ground_depth(uv)[0]
    manual = float((target - cam.C) @ -cam.R[2])
    assert depth == pytest.approx(manual, rel=1e-9)


def test_ground_depth_is_nan_above_the_horizon():
    cam = truth_camera()
    horizon = cam.horizon_y(cam.width / 2)
    depth = cam.ground_depth(np.array([[cam.width / 2, horizon - 40]]))
    assert math.isnan(float(depth[0]))


def test_grid_segments_never_cross_the_horizon():
    cam = truth_camera()
    horizon = cam.horizon_y(cam.width / 2)
    for run in ground_grid_segments(cam, extent=8.0, spacing=1.0):
        for _, v in run:
            assert v > horizon - 1e-6


def test_vanishing_point_of_parallel_lines_is_none():
    assert vanishing_point(((0, 0), (10, 0)), ((0, 5), (10, 5)), 100.0) is None


def test_scale_shift_fit_recovers_a_known_transform():
    rng = np.random.default_rng(3)
    depth = rng.uniform(1.5, 12.0, 4000)
    s, t = 0.31, 0.02
    disparity = (1.0 / depth - t) / s
    # Contaminate a third of the samples: they are furniture, not floor.
    depth_obs = depth.copy()
    outliers = rng.choice(len(depth), 1300, replace=False)
    depth_obs[outliers] *= rng.uniform(0.3, 0.8, len(outliers))
    s_hat, t_hat, frac = fit_scale_shift_to_ground(disparity, depth_obs, rng=rng)
    assert s_hat == pytest.approx(s, rel=0.02)
    assert t_hat == pytest.approx(t, abs=0.01)
    assert frac > 0.55
