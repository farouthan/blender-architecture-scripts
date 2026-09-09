"""HTTP API for the re-shoot pipeline.

Every heavy pass is dispatched to the job queue and polled, so no request
blocks.  Confirming a step writes it to the project on disk and clears the
results derived from it, which is what makes the back button cheap: going back
re-reads the confirmed state instead of recomputing it.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from . import config, store
from .geometry import (
    Camera,
    ground_grid_segments,
    solve_camera,
    vanishing_point,
)
from .jobs import jobs
from .pipelines import depth as depth_pipe
from .pipelines import generate as gen_pipe
from .pipelines import humans as humans_pipe
from .pipelines import proxy as proxy_pipe
from .vanishing import auto_solve_control_points

app = FastAPI(title="Re-shoot", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

Image.MAX_IMAGE_PIXELS = 120_000_000


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _load_image(project_id: str, state: dict) -> Image.Image:
    path = store.asset_path(project_id, state["image"]["file"])
    return Image.open(path).convert("RGB")


def _camera_from_state(state: dict) -> Camera:
    solve = state.get("solve")
    if not solve or not solve.get("camera"):
        raise HTTPException(409, "This project has no confirmed camera solve yet.")
    c = solve["camera"]
    return Camera(
        width=c["width"],
        height=c["height"],
        focal_px=c["focal_px"],
        principal_point=tuple(c["principal_point"]),
        rotation=tuple(c["rotation"]),
        position=tuple(c["position"]),
    )


def _solve_from_control_points(
    width: int, height: int, control: dict, camera_height: float, principal=None
) -> tuple[Camera, dict]:
    """Canonical server-side solve, mirroring the browser's live preview."""
    diag = math.hypot(width, height)

    def vp_of(axis: str):
        lines = control.get(axis)
        if not lines or len(lines) < 2:
            raise HTTPException(400, f"Axis {axis} needs two control lines.")
        a = (tuple(lines[0][0]), tuple(lines[0][1]))
        b = (tuple(lines[1][0]), tuple(lines[1][1]))
        vp = vanishing_point(a, b, diag)
        if vp is None:
            raise HTTPException(
                400,
                f"The two lines for axis {axis} are parallel, so they have no "
                "vanishing point.  Give them a little convergence.",
            )
        return vp

    vp_a, vp_b = vp_of("axisA"), vp_of("axisB")
    origin = control.get("origin")
    if not origin or len(origin) != 2:
        raise HTTPException(400, "The solve needs an origin handle on the floor.")

    cam, error = solve_camera(
        width, height, vp_a, vp_b, tuple(origin), float(camera_height), principal
    )
    if cam is None:
        raise HTTPException(400, error or "The solve did not converge.")
    return cam, {
        "vanishingPoints": {"axisA": vp_a.tolist(), "axisB": vp_b.tolist()},
    }


def _project_response(state: dict) -> dict:
    return state


def _job_response(job) -> JSONResponse:
    return JSONResponse(job.to_dict(), status_code=202)


# --------------------------------------------------------------------------- #
# Health and capabilities
# --------------------------------------------------------------------------- #


@app.get("/api/health")
def health() -> dict:
    def importable(name: str) -> bool:
        import importlib.util

        try:
            return importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            return False

    torch_ok = importable("torch")
    return {
        "ok": True,
        "backends": {
            "depth": {
                "configured": config.DEPTH_BACKEND,
                "depthAnything": torch_ok and importable("transformers"),
                "fallback": "planar-room",
            },
            "humans": {
                "configured": config.HUMANS_BACKEND,
                "hmr2": importable("hmr2") and bool(config.HMR2_CHECKPOINT),
                "keypointRcnn": torch_ok and importable("torchvision"),
                "fallback": "manual",
            },
            "generate": {
                "configured": config.GEN_BACKEND,
                "diffusers": torch_ok and importable("diffusers"),
                "a1111Url": config.A1111_URL,
                "fallback": "proxy-reprojection",
            },
        },
    }


# --------------------------------------------------------------------------- #
# Step 1 -- the photo
# --------------------------------------------------------------------------- #


@app.post("/api/projects")
async def create_project(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file was empty.")
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"Image is larger than {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
        )
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as exc:
        raise HTTPException(400, f"That file could not be read as an image: {exc}") from exc

    # Store an EXIF-corrected working copy so pixel coordinates in the UI, the
    # solve and every render agree with what the user sees.
    if max(img.size) > config.WORKING_MAX_EDGE:
        scale = config.WORKING_MAX_EDGE / max(img.size)
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.LANCZOS,
        )
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=94)

    state = store.create(buf.getvalue(), file.filename or "photo.jpg", img.width, img.height)
    return _project_response(state)


@app.get("/api/projects")
def list_projects() -> dict:
    return {"projects": store.list_projects()}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    try:
        return _project_response(store.load(project_id))
    except store.NotFound as exc:
        raise HTTPException(404, str(exc)) from exc


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    store.delete(project_id)
    return {"ok": True}


@app.get("/api/projects/{project_id}/asset/{name:path}")
def get_asset(project_id: str, name: str):
    try:
        path = store.asset_path(project_id, name)
    except store.NotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    if not path.is_file():
        raise HTTPException(404, f"no asset {name!r}")
    return FileResponse(path)


# --------------------------------------------------------------------------- #
# Step 2 -- perspective solve
# --------------------------------------------------------------------------- #


@app.post("/api/projects/{project_id}/solve/auto")
def solve_auto(project_id: str):
    state = store.load(project_id)

    def run(report):
        report(0.1, "Reading the photo")
        img = _load_image(project_id, state)
        w, h = img.size
        small = img.convert("L")
        scale = min(1.0, 900 / max(w, h))
        if scale < 1.0:
            small = small.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
        report(0.3, "Finding straight edges")
        control = auto_solve_control_points(np.asarray(small, dtype=np.float32), w, h)
        report(0.9, "Estimating vanishing points")
        return control

    return _job_response(jobs.submit("solve-auto", project_id, run))


@app.post("/api/projects/{project_id}/solve/preview")
def solve_preview(project_id: str, payload: dict = Body(...)) -> dict:
    """Recompute the camera without saving -- used to verify the live preview."""
    state = store.load(project_id)
    w, h = state["image"]["width"], state["image"]["height"]
    cam, extra = _solve_from_control_points(
        w, h, payload["controlPoints"], payload.get("cameraHeight", 1.6),
        payload.get("principalPoint"),
    )
    return {
        "camera": cam.to_dict(),
        **extra,
        "grid": ground_grid_segments(cam),
        "horizon": [cam.horizon_y(0), cam.horizon_y(w)],
    }


@app.put("/api/projects/{project_id}/solve")
def confirm_solve(project_id: str, payload: dict = Body(...)) -> dict:
    state = store.load(project_id)
    w, h = state["image"]["width"], state["image"]["height"]
    control = payload["controlPoints"]
    camera_height = float(payload.get("cameraHeight", 1.6))
    cam, extra = _solve_from_control_points(
        w, h, control, camera_height, payload.get("principalPoint")
    )

    def mutate(s: dict) -> None:
        previous = json.dumps((s.get("solve") or {}).get("camera"), sort_keys=True)
        s["solve"] = {
            "controlPoints": control,
            "cameraHeight": camera_height,
            "camera": cam.to_dict(),
            **extra,
            "confirmed": True,
        }
        # Only throw away downstream work when the camera actually moved.
        if previous != json.dumps(cam.to_dict(), sort_keys=True):
            s["cleared"] = store.invalidate_downstream(s, "solve")
        else:
            s["cleared"] = []
        s["step"] = "proxy"

    return _project_response(store.update(project_id, mutate))


# --------------------------------------------------------------------------- #
# Step 3 -- depth and the primitive proxy
# --------------------------------------------------------------------------- #


@app.post("/api/projects/{project_id}/proxy")
def build_proxy(project_id: str, payload: dict = Body(default={})):
    state = store.load(project_id)
    cam = _camera_from_state(state)
    force_depth = bool(payload.get("recomputeDepth", False))
    voxel = float(payload.get("voxel", 0.09))

    def run(report):
        img = _load_image(project_id, state)
        existing = (state.get("proxy") or {}).get("depth")
        disparity = None
        backend = ""
        note = ""
        if existing and not force_depth:
            path = store.asset_path(project_id, existing["file"])
            if path.is_file():
                report(0.05, "Reusing the depth map")
                raw = np.asarray(Image.open(path), dtype=np.float32)
                disparity = raw / 65535.0
                backend = existing.get("backend", "cached")
                note = existing.get("note", "")
        if disparity is None:
            result = depth_pipe.estimate(img, cam, report)
            disparity = result.disparity
            backend, note = result.backend, result.note
            store.write_asset(project_id, "depth.png", depth_pipe.to_png_bytes(disparity))

        dh, dw = disparity.shape
        colors = np.asarray(img.resize((dw, dh), Image.LANCZOS), dtype=np.float32)

        scale, shift, inliers = proxy_pipe.fit_to_ground(cam, disparity, report)
        primitives, stats = proxy_pipe.extract_primitives(
            cam, disparity, scale, shift, colors=colors, voxel=voxel, report=report
        )

        proxy = {
            "depth": {
                "file": "depth.png",
                "width": dw,
                "height": dh,
                "backend": backend,
                "note": note,
            },
            "fit": {"scale": scale, "shift": shift, "inlierFraction": inliers},
            "stats": stats,
            "primitives": [p.to_dict() for p in primitives],
            "confirmed": False,
        }
        store.update(project_id, lambda s: s.__setitem__("proxy", proxy))
        return proxy

    return _job_response(jobs.submit("proxy", project_id, run))


@app.put("/api/projects/{project_id}/proxy")
def confirm_proxy(project_id: str, payload: dict = Body(...)) -> dict:
    primitives = payload.get("primitives")
    if primitives is None:
        raise HTTPException(400, "Nothing to confirm: no primitives were sent.")

    def mutate(s: dict) -> None:
        proxy = s.get("proxy")
        if proxy is None:
            raise HTTPException(409, "Build the proxy before confirming it.")
        changed = json.dumps(proxy.get("primitives"), sort_keys=True) != json.dumps(
            primitives, sort_keys=True
        )
        proxy["primitives"] = primitives
        proxy["confirmed"] = True
        s["cleared"] = store.invalidate_downstream(s, "proxy") if changed else []
        s["step"] = "bodies"

    return _project_response(store.update(project_id, mutate))


# --------------------------------------------------------------------------- #
# Step 4 -- people
# --------------------------------------------------------------------------- #


@app.post("/api/projects/{project_id}/bodies")
def detect_bodies(project_id: str):
    state = store.load(project_id)
    cam = _camera_from_state(state)

    def run(report):
        img = _load_image(project_id, state)
        bodies, backend, note = humans_pipe.recover(img, cam, report)
        payload = {
            "backend": backend,
            "note": note,
            "bodies": [b.to_dict() for b in bodies],
            "confirmed": False,
        }
        store.update(project_id, lambda s: s.__setitem__("bodies", payload))
        return payload

    return _job_response(jobs.submit("bodies", project_id, run))


@app.post("/api/projects/{project_id}/bodies/from-box")
def body_from_box(project_id: str, payload: dict = Body(...)) -> dict:
    """Place one body from a box the user drew.  Fast enough to be synchronous."""
    state = store.load(project_id)
    cam = _camera_from_state(state)
    bbox = payload.get("bbox")
    if not bbox or len(bbox) != 4:
        raise HTTPException(400, "Send a bbox as [x1, y1, x2, y2] in image pixels.")
    body, warning = humans_pipe.body_from_bbox(
        cam, tuple(bbox), payload.get("id") or f"body-{np.random.randint(1e6):06d}", "manual"
    )
    if body is None:
        raise HTTPException(400, warning or "That box could not be placed on the floor.")
    return {"body": body.to_dict(), "warning": warning}


@app.put("/api/projects/{project_id}/bodies")
def confirm_bodies(project_id: str, payload: dict = Body(...)) -> dict:
    bodies = payload.get("bodies")
    if bodies is None:
        raise HTTPException(400, "Nothing to confirm: no bodies were sent.")

    def mutate(s: dict) -> None:
        current = s.get("bodies") or {"backend": "manual", "note": ""}
        changed = json.dumps(current.get("bodies"), sort_keys=True) != json.dumps(
            bodies, sort_keys=True
        )
        current["bodies"] = bodies
        current["confirmed"] = True
        s["bodies"] = current
        s["cleared"] = store.invalidate_downstream(s, "bodies") if changed else []
        s["step"] = "navigate"

    return _project_response(store.update(project_id, mutate))


# --------------------------------------------------------------------------- #
# Steps 5 and 6 -- lock an angle, render it
# --------------------------------------------------------------------------- #


@app.post("/api/projects/{project_id}/shots")
async def create_shot(
    project_id: str,
    camera: str = Form(...),
    settings: str = Form("{}"),
    depth: UploadFile = File(...),
    normal: UploadFile = File(...),
    preview: UploadFile | None = File(None),
):
    state = store.load(project_id)
    try:
        shot_camera = json.loads(camera)
        opts = json.loads(settings or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"Bad JSON in the request: {exc}") from exc

    depth_png = await depth.read()
    normal_png = await normal.read()
    preview_png = await preview.read() if preview is not None else None
    if not depth_png or not normal_png:
        raise HTTPException(400, "The depth and normal control renders are required.")

    shot_id = f"shot-{len(state.get('shots') or []) + 1:03d}-{np.random.randint(1e6):06d}"
    prefix = f"renders/{shot_id}"
    store.write_asset(project_id, f"{prefix}-depth.png", depth_png)
    store.write_asset(project_id, f"{prefix}-normal.png", normal_png)
    if preview_png:
        store.write_asset(project_id, f"{prefix}-preview.png", preview_png)

    source_png = store.asset_path(project_id, state["image"]["file"]).read_bytes()

    def run(report):
        report(0.05, "Preparing control images")
        req = gen_pipe.GenerationRequest(
            source_png=source_png,
            depth_png=depth_png,
            normal_png=normal_png,
            preview_png=preview_png,
            prompt=opts.get("prompt") or gen_pipe.DEFAULT_PROMPT,
            negative_prompt=opts.get("negativePrompt") or gen_pipe.DEFAULT_NEGATIVE,
            strength=float(opts.get("strength", 0.72)),
            guidance=float(opts.get("guidance", 7.0)),
            steps=int(opts.get("steps", 30)),
            seed=int(opts.get("seed", -1)),
            depth_weight=float(opts.get("depthWeight", 1.0)),
            normal_weight=float(opts.get("normalWeight", 0.6)),
        )
        result = gen_pipe.generate(req, report)
        store.write_asset(project_id, f"{prefix}-result.png", result.png)
        record = {
            "id": shot_id,
            "camera": shot_camera,
            "settings": opts,
            "renders": {
                "depth": f"{prefix}-depth.png",
                "normal": f"{prefix}-normal.png",
                "preview": f"{prefix}-preview.png" if preview_png else None,
            },
            "result": f"{prefix}-result.png",
            "backend": result.backend,
            "note": result.note,
            "seed": result.seed,
        }

        def mutate(s: dict) -> None:
            shots = [x for x in (s.get("shots") or []) if x["id"] != shot_id]
            shots.append(record)
            s["shots"] = shots[-12:]
            s["step"] = "render"

        store.update(project_id, mutate)
        return record

    return _job_response(jobs.submit("generate", project_id, run))


@app.put("/api/projects/{project_id}/step")
def set_step(project_id: str, payload: dict = Body(...)) -> dict:
    """Move the wizard's pointer without touching any confirmed result."""
    step = payload.get("step")
    if step not in store.STEPS:
        raise HTTPException(400, f"Unknown step {step!r}.")
    return _project_response(store.update(project_id, lambda s: s.__setitem__("step", step)))


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"unknown job {job_id!r}")
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    return {"cancelled": jobs.cancel(job_id)}


# --------------------------------------------------------------------------- #
# Static frontend
# --------------------------------------------------------------------------- #

_DIST = config.ROOT.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="frontend")


@app.get("/", include_in_schema=False)
def index() -> Response:
    if _DIST.is_dir():
        return FileResponse(_DIST / "index.html")
    return Response(
        "The frontend has not been built yet.  Run `npm install && npm run build` "
        "in reshoot/frontend, or `npm run dev` for the dev server.",
        media_type="text/plain",
        status_code=503,
    )
