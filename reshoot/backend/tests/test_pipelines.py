import numpy as np
import pytest

from reshoot.pipelines.humans import (
    body_from_bbox,
    template_joints,
    yaw_from_shoulders,
)
from reshoot.pipelines.proxy import extract_primitives, fit_to_ground
from reshoot.vanishing import auto_solve_control_points
from reshoot.geometry import focal_from_vanishing_points, vanishing_point
from synthetic import TRUTH_BOXES, render_depth, render_wireframe, truth_camera

import math


def test_auto_solve_recovers_the_focal_length():
    cam = truth_camera()
    grey = np.asarray(render_wireframe(cam).convert("L"), dtype=np.float32)
    control = auto_solve_control_points(grey, cam.width, cam.height)
    assert control["auto"], "line detection should find both horizontal axes"
    diag = math.hypot(cam.width, cam.height)
    vp_a = vanishing_point(tuple(map(tuple, control["axisA"][0])),
                          tuple(map(tuple, control["axisA"][1])), diag)
    vp_b = vanishing_point(tuple(map(tuple, control["axisB"][0])),
                          tuple(map(tuple, control["axisB"][1])), diag)
    focal = focal_from_vanishing_points(vp_a, vp_b, (cam.width / 2, cam.height / 2))
    assert focal == pytest.approx(cam.focal_px, rel=0.10)


def test_ground_fit_is_near_exact_on_true_depth():
    cam = truth_camera()
    disparity = render_depth(cam)
    scale, shift, inliers = fit_to_ground(cam, disparity)
    assert inliers > 0.5
    # Reconstructed floor depth should match the analytic ground plane.
    from reshoot.pipelines.proxy import unproject

    points, valid = unproject(cam, disparity, scale, shift)
    floor = valid & (np.abs(points[:, 1]) < 0.05)
    assert floor.sum() > 2000


def test_primitive_extraction_finds_the_boxes():
    cam = truth_camera()
    disparity = render_depth(cam)
    scale, shift, _ = fit_to_ground(cam, disparity)
    primitives, stats = extract_primitives(cam, disparity, scale, shift)
    solids = [p for p in primitives if p.kind != "plane"]
    assert len(primitives) == len(solids) + 1, "exactly one floor plane"
    assert 2 <= len(solids) <= 4, f"expected the two boxes, got {len(solids)}"

    for lo, hi in TRUTH_BOXES:
        centre = np.array([(a + b) / 2 for a, b in zip(lo, hi)])
        nearest = min(solids, key=lambda p: np.linalg.norm(np.array(p.position) - centre))
        # A single view only sees the front faces, so the proxy is allowed to be
        # a bit shy of the truth; it has to be in the right place though.
        assert np.linalg.norm(np.array(nearest.position)[[0, 2]] - centre[[0, 2]]) < 0.45


def test_body_from_bbox_recovers_position_and_height():
    cam = truth_camera()
    foot = np.array([1.2, 0.0, 2.0])
    height = 1.78
    uv, visible = cam.project(np.array([foot, foot + [0, height, 0]]))
    assert visible.all()
    bbox = (uv[1][0] - 40, uv[1][1], uv[0][0] + 40, uv[0][1])
    body, warning = body_from_bbox(cam, bbox, "b0")
    assert warning is None
    assert body.height == pytest.approx(height, abs=0.01)
    assert body.position[0] == pytest.approx(foot[0], abs=0.02)
    assert body.position[2] == pytest.approx(foot[2], abs=0.02)
    assert body.position[1] == 0.0


def test_body_height_is_clamped_for_an_absurd_box():
    cam = truth_camera()
    body, warning = body_from_bbox(cam, (400, 40, 460, 700), "b1")
    assert body is not None
    assert 1.2 <= body.height <= 2.1
    assert warning and "clamped" in warning


@pytest.mark.parametrize("height", [1.45, 1.70, 1.95])
def test_template_joints_stand_on_the_floor(height):
    joints = np.array(template_joints(height))
    assert joints[:, 1].min() == pytest.approx(0.0, abs=1e-12)
    # The head joint sits under the scalp, so the joint span is a fixed
    # fraction of stature rather than stature itself.
    span_fraction = (0.640 + 0.945) / 1.70
    assert joints[:, 1].max() == pytest.approx(height * span_fraction, rel=1e-9)
    assert joints[:, 1].max() < height


def test_yaw_from_shoulders_detects_a_turned_body():
    cam = truth_camera()
    foot = np.array([0.5, 0.0, 2.5])
    height = 1.75
    shoulder_y = foot[1] + height * 0.82
    for truth_yaw in (0.0, math.pi / 2, math.pi, -math.pi / 2):
        c, s = math.cos(truth_yaw), math.sin(truth_yaw)
        # Body-local +x is the subject's left; rotate it into the world.
        left = np.array([c, 0.0, -s]) * 0.19
        left_pt = foot + [0, shoulder_y, 0] + left
        right_pt = foot + [0, shoulder_y, 0] - left
        uv, visible = cam.project(np.stack([left_pt, right_pt]))
        if not visible.all():
            continue
        yaw = yaw_from_shoulders(cam, foot, uv[0], uv[1], height * 0.82)
        assert yaw is not None
        delta = (yaw - truth_yaw + math.pi) % (2 * math.pi) - math.pi
        assert abs(delta) < 0.15, f"yaw {yaw} vs {truth_yaw}"


def test_body_from_bbox_rejects_a_box_above_the_horizon():
    cam = truth_camera()
    horizon = cam.horizon_y(cam.width / 2)
    body, warning = body_from_bbox(cam, (400, 20, 500, horizon - 30), "b2")
    assert body is None
    assert "horizon" in warning


@pytest.mark.parametrize("yaw_deg", [0.0, 20.0, -35.0, 70.0])
def test_footprint_yaw_uses_the_threejs_convention(yaw_deg):
    """A box rotated by `rotation.y = yaw` must be recovered with that yaw.

    Rotation about +y sends a mesh's local +x to world (cos yaw, 0, -sin yaw),
    so the viewer can apply the returned angle directly with no sign fixing.
    """
    from reshoot.pipelines.proxy import _oriented_footprint

    yaw = math.radians(yaw_deg)
    half_a, half_b = 0.9, 0.3
    rng = np.random.default_rng(11)
    local = np.stack(
        [rng.uniform(-half_a, half_a, 4000), rng.uniform(-half_b, half_b, 4000)], axis=1
    )
    centre = np.array([1.4, -2.1])
    # local (x, z) -> world (x cos + z sin, -x sin + z cos)
    world = np.stack(
        [
            local[:, 0] * math.cos(yaw) + local[:, 1] * math.sin(yaw),
            -local[:, 0] * math.sin(yaw) + local[:, 1] * math.cos(yaw),
        ],
        axis=1,
    ) + centre

    found_centre, found_yaw, ext_a, ext_b = _oriented_footprint(world)
    assert found_centre == pytest.approx(centre, abs=0.02)
    assert max(ext_a, ext_b) == pytest.approx(2 * half_a, abs=0.05)
    assert min(ext_a, ext_b) == pytest.approx(2 * half_b, abs=0.05)
    # The rectangle is symmetric, so the yaw is only defined modulo pi.
    delta = (found_yaw - yaw + math.pi / 2) % math.pi - math.pi / 2
    assert abs(delta) < math.radians(3.0), f"{math.degrees(found_yaw)} vs {yaw_deg}"
