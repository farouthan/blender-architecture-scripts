"""Single-image human recovery and placement in the solved camera frame.

Three tiers, tried in order:

1. **4D-Humans / HMR 2.0** -- a real posed SMPL body with vertices.
2. **torchvision keypoint R-CNN** -- 2D COCO joints, lifted onto the ground
   plane and used to orient a template body.
3. **Manual** -- the user drags a box round each person in the UI and the same
   placement maths runs on that box.

All three produce the same record, so the viewer and the exporter do not care
which one ran: a floor position, a height, a yaw, and a set of body-local
joints with feet at ``y = 0``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .. import config
from ..geometry import Camera

# SMPL's 24-joint kinematic tree.
SMPL_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21]
SMPL_NAMES = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee",
    "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot",
    "neck", "left_collar", "right_collar", "head", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_hand", "right_hand",
]
# Neutral standing rest pose, metres, pelvis at the origin, +x to the subject's
# left, +y up, +z the way the subject faces.  Total stature is 1.70 m.
_TEMPLATE_PELVIS_RELATIVE = np.array([
    [0.000,  0.000,  0.000], [0.070, -0.085,  0.000], [-0.070, -0.085,  0.000],
    [0.000,  0.120,  0.000], [0.100, -0.480,  0.000], [-0.100, -0.480,  0.000],
    [0.000,  0.260,  0.000], [0.090, -0.890, -0.020], [-0.090, -0.890, -0.020],
    [0.000,  0.320,  0.000], [0.095, -0.945,  0.120], [-0.095, -0.945,  0.120],
    [0.000,  0.520, -0.010], [0.075,  0.420,  0.010], [-0.075,  0.420,  0.010],
    [0.000,  0.640,  0.020], [0.170,  0.470, -0.010], [-0.170,  0.470, -0.010],
    [0.430,  0.460, -0.020], [-0.430,  0.460, -0.020], [0.680,  0.455, -0.020],
    [-0.680,  0.455, -0.020], [0.760,  0.450, -0.020], [-0.760,  0.450, -0.020],
])
TEMPLATE_STATURE = 1.70
_FOOT_Y = float(_TEMPLATE_PELVIS_RELATIVE[:, 1].min())

# Heights outside this range are almost certainly a bad box, not a tall person.
MIN_HEIGHT = 1.20
MAX_HEIGHT = 2.10
DEFAULT_HEIGHT = 1.70

# COCO keypoint order used by torchvision's keypoint R-CNN.
COCO_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
]


@dataclass
class Body:
    id: str
    bbox: tuple[float, float, float, float]
    position: tuple[float, float, float]
    rotationY: float
    height: float
    joints: list[list[float]] = field(default_factory=list)
    parents: list[int] = field(default_factory=lambda: list(SMPL_PARENTS))
    names: list[str] = field(default_factory=lambda: list(SMPL_NAMES))
    keypoints2d: list[list[float]] | None = None
    mesh: str | None = None  # project-relative path to a mesh asset, if any
    source: str = "manual"
    confidence: float = 1.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "bbox": list(self.bbox),
            "position": list(self.position),
            "rotationY": self.rotationY,
            "height": self.height,
            "joints": self.joints,
            "parents": self.parents,
            "names": self.names,
            "keypoints2d": self.keypoints2d,
            "mesh": self.mesh,
            "source": self.source,
            "confidence": self.confidence,
        }


def template_joints(height: float) -> list[list[float]]:
    """Rest-pose joints for a person of ``height``, with the feet at ``y = 0``."""
    scale = height / TEMPLATE_STATURE
    pts = _TEMPLATE_PELVIS_RELATIVE.copy()
    pts[:, 1] -= _FOOT_Y
    return (pts * scale).tolist()


def floor_point_from_pixel(cam: Camera, u: float, v: float) -> np.ndarray | None:
    """Where a pixel's ray meets the ground plane, or ``None`` above the horizon."""
    d = cam.ray(u, v)
    if d[1] > -1e-6:
        return None
    t = -cam.C[1] / d[1]
    if t <= 0:
        return None
    return cam.C + t * d


def height_from_bbox(cam: Camera, foot: np.ndarray, top_v: float, u: float) -> float:
    """Stature implied by the top of the bounding box above a known floor point.

    Solves for the ``h`` that makes ``foot + h * up`` project to image row
    ``top_v``.  Closed form, because the projection is linear in ``h`` before the
    perspective divide.
    """
    cx, cy = cam.principal_point
    A = cam.R @ (foot - cam.C)
    B = cam.R @ np.array([0.0, 1.0, 0.0])
    k = cy - top_v
    denom = cam.focal_px * B[1] + k * B[2]
    if abs(denom) < 1e-9:
        return DEFAULT_HEIGHT
    h = -(k * A[2] + cam.focal_px * A[1]) / denom
    if not math.isfinite(h) or h <= 0:
        return DEFAULT_HEIGHT
    return float(h)


def yaw_facing_camera(cam: Camera, foot: np.ndarray) -> float:
    """Yaw that turns the body to face the camera."""
    d = cam.C - foot
    return float(math.atan2(d[0], d[2]))


def yaw_from_shoulders(
    cam: Camera, foot: np.ndarray, left_px, right_px, shoulder_height: float
) -> float | None:
    """Yaw from the image positions of the two shoulders.

    Both shoulders are unprojected onto the horizontal plane at shoulder height,
    which is accurate enough to tell which way a standing person is turned.
    """
    plane_y = foot[1] + shoulder_height

    def on_plane(px) -> np.ndarray | None:
        d = cam.ray(px[0], px[1])
        if abs(d[1]) < 1e-9:
            return None
        t = (plane_y - cam.C[1]) / d[1]
        if t <= 0:
            return None
        return cam.C + t * d

    a, b = on_plane(left_px), on_plane(right_px)
    if a is None or b is None:
        return None
    left = a - b
    left[1] = 0.0
    if float(np.linalg.norm(left)) < 1e-4:
        return None
    left /= np.linalg.norm(left)
    up = np.array([0.0, 1.0, 0.0])
    forward = np.cross(left, up)
    return float(math.atan2(forward[0], forward[2]))


def body_from_bbox(
    cam: Camera,
    bbox: tuple[float, float, float, float],
    body_id: str,
    source: str = "manual",
    keypoints2d: list[list[float]] | None = None,
    confidence: float = 1.0,
) -> tuple[Body | None, str | None]:
    """Place a template body under an image-space bounding box."""
    x1, y1, x2, y2 = (float(v) for v in bbox)
    x1, x2 = min(x1, x2), max(x1, x2)
    y1, y2 = min(y1, y2), max(y1, y2)
    u = (x1 + x2) / 2.0
    foot = floor_point_from_pixel(cam, u, y2)
    if foot is None:
        return None, (
            "The bottom of that box is above the horizon, so the feet cannot "
            "touch the floor.  Drag the box down or re-check the solve."
        )
    raw_height = height_from_bbox(cam, foot, y1, u)
    height = float(min(max(raw_height, MIN_HEIGHT), MAX_HEIGHT))

    yaw = None
    if keypoints2d is not None and len(keypoints2d) >= 7:
        ls, rs = keypoints2d[5], keypoints2d[6]
        if len(ls) < 3 or (ls[2] > 0.3 and rs[2] > 0.3):
            yaw = yaw_from_shoulders(cam, foot, ls[:2], rs[:2], height * 0.82)
    if yaw is None:
        yaw = yaw_facing_camera(cam, foot)

    return (
        Body(
            id=body_id,
            bbox=(x1, y1, x2, y2),
            position=(float(foot[0]), 0.0, float(foot[2])),
            rotationY=yaw,
            height=height,
            joints=template_joints(height),
            keypoints2d=keypoints2d,
            source=source,
            confidence=confidence,
        ),
        None if MIN_HEIGHT < raw_height < MAX_HEIGHT else
        f"Implied height was {raw_height:.2f} m; clamped to {height:.2f} m.",
    )


# --------------------------------------------------------------------------- #
# Backends
# --------------------------------------------------------------------------- #

_detector_cache: dict[str, object] = {}


def _torch_device():
    import torch

    return config.TORCH_DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")


def _load_keypoint_rcnn():
    if "keypointrcnn" in _detector_cache:
        return _detector_cache["keypointrcnn"]
    try:
        import torch
        from torchvision.models.detection import (
            KeypointRCNN_ResNet50_FPN_Weights,
            keypointrcnn_resnet50_fpn,
        )
    except Exception:
        _detector_cache["keypointrcnn"] = None
        return None
    try:
        weights = KeypointRCNN_ResNet50_FPN_Weights.DEFAULT
        model = keypointrcnn_resnet50_fpn(weights=weights).eval().to(_torch_device())
    except Exception:
        _detector_cache["keypointrcnn"] = None
        return None
    _detector_cache["keypointrcnn"] = model
    return model


def _detect_keypoint_rcnn(image, threshold: float = 0.75) -> list[dict]:
    model = _load_keypoint_rcnn()
    if model is None:
        return []
    import torch
    from torchvision.transforms.functional import to_tensor

    with torch.no_grad():
        tensor = to_tensor(image.convert("RGB")).to(_torch_device())
        out = model([tensor])[0]
    people: list[dict] = []
    for box, score, kps, kscores in zip(
        out["boxes"].cpu().numpy(),
        out["scores"].cpu().numpy(),
        out["keypoints"].cpu().numpy(),
        out["keypoints_scores"].cpu().numpy(),
    ):
        if float(score) < threshold:
            continue
        norm = 1.0 / (1.0 + np.exp(-kscores))
        people.append(
            {
                "bbox": [float(v) for v in box],
                "score": float(score),
                "keypoints2d": [
                    [float(x), float(y), float(c)] for (x, y, _), c in zip(kps, norm)
                ],
            }
        )
    return people


def _run_hmr2(image, cam: Camera, report) -> list[dict] | None:
    """4D-Humans / HMR 2.0, if the package and its checkpoint are present."""
    try:
        import torch
        from hmr2.models import load_hmr2
        from hmr2.utils import recursive_to
        from hmr2.datasets.vitdet_dataset import ViTDetDataset
    except Exception:
        return None
    checkpoint = config.HMR2_CHECKPOINT
    if not checkpoint:
        return None
    try:
        report(0.2, "Loading HMR 2.0")
        model, model_cfg = load_hmr2(checkpoint)
        device = _torch_device()
        model = model.to(device).eval()

        people = _detect_keypoint_rcnn(image, threshold=0.6)
        if not people:
            return []
        boxes = np.array([p["bbox"] for p in people], dtype=float)
        dataset = ViTDetDataset(model_cfg, np.array(image.convert("RGB")), boxes)
        loader = torch.utils.data.DataLoader(dataset, batch_size=8, shuffle=False)

        results: list[dict] = []
        for batch in loader:
            batch = recursive_to(batch, device)
            with torch.no_grad():
                out = model(batch)
            joints = out["pred_keypoints_3d"].cpu().numpy()
            verts = out["pred_vertices"].cpu().numpy()
            for j, v in zip(joints, verts):
                results.append({"joints3d": j, "vertices": v})
        report(0.8, "Recovered SMPL bodies")
        return [
            {**person, "smpl": res} for person, res in zip(people, results)
        ]
    except Exception:
        return None


def _bodies_from_smpl(cam: Camera, detections: list[dict]) -> list[Body]:
    """Convert HMR 2.0 output into placed bodies.

    HMR predicts a body in its own root-relative frame; the camera solve is what
    puts it in the room, so the predicted pose supplies the joint layout and the
    yaw while the bounding box supplies the floor position and the stature.
    """
    bodies: list[Body] = []
    for n, det in enumerate(detections):
        smpl = det.get("smpl") or {}
        joints = np.asarray(smpl.get("joints3d", []), dtype=float)
        body, _ = body_from_bbox(
            cam,
            det["bbox"],
            f"body-{n:02d}",
            source="hmr2",
            keypoints2d=det.get("keypoints2d"),
            confidence=det.get("score", 1.0),
        )
        if body is None:
            continue
        if joints.ndim == 2 and len(joints) >= 24:
            local = joints[:24].copy()
            # HMR uses y-down; flip to the app's y-up frame and stand it on the floor.
            local[:, 1] *= -1.0
            local[:, 2] *= -1.0
            span = float(local[:, 1].max() - local[:, 1].min())
            if span > 1e-3:
                local *= body.height / (span * 1.06)  # joints exclude scalp and sole
            local[:, 1] -= local[:, 1].min()
            body.joints = local.tolist()
        bodies.append(body)
    return bodies


def recover(image, cam: Camera, report=lambda *_: None) -> tuple[list[Body], str, str]:
    """Recover every person in the photo.  Returns ``(bodies, backend, note)``."""
    backend = config.HUMANS_BACKEND
    if backend in ("auto", "hmr2"):
        report(0.1, "Looking for a human mesh recovery backend")
        detections = _run_hmr2(image, cam, report)
        if detections is not None:
            return _bodies_from_smpl(cam, detections), "hmr2", ""
        if backend == "hmr2":
            raise RuntimeError(
                "HMR 2.0 was requested but 4D-Humans is not installed or "
                "RESHOOT_HMR2_CHECKPOINT is unset."
            )

    if backend in ("auto", "keypoints"):
        report(0.3, "Detecting people")
        people = _detect_keypoint_rcnn(image)
        if people:
            report(0.75, f"Placing {len(people)} bodies")
            bodies: list[Body] = []
            for n, person in enumerate(people):
                body, _ = body_from_bbox(
                    cam,
                    person["bbox"],
                    f"body-{n:02d}",
                    source="keypoints",
                    keypoints2d=person["keypoints2d"],
                    confidence=person["score"],
                )
                if body is not None:
                    bodies.append(body)
            return (
                bodies,
                "keypoint-rcnn",
                "Poses come from 2D keypoints lifted onto the ground plane, not "
                "from a full SMPL fit.  Nudge anyone who sits wrong.",
            )
        if _load_keypoint_rcnn() is not None:
            return [], "keypoint-rcnn", "No people were detected in this photo."

    return (
        [],
        "manual",
        "No human recovery backend is installed.  Draw a box around each "
        "person and the camera solve will stand them on the floor.",
    )
