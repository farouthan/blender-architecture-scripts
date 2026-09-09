"""End-to-end walk through all six steps against the real HTTP app."""

from __future__ import annotations

import io
import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from synthetic import photo_bytes, truth_camera


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from reshoot import config, store

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(store, "PROJECTS_DIR", tmp_path / "projects")
    (tmp_path / "projects").mkdir(parents=True, exist_ok=True)

    from reshoot.app import app

    with TestClient(app) as c:
        yield c


def wait(client: TestClient, response, timeout: float = 180.0) -> dict:
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error", "cancelled"):
            assert job["status"] == "done", job.get("error")
            return job["result"]
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish in {timeout}s")


def make_project(client: TestClient) -> dict:
    resp = client.post(
        "/api/projects", files={"file": ("room.png", photo_bytes(), "image/png")}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def confirm_solve(client: TestClient, project: dict) -> dict:
    cam = truth_camera()
    # Two control lines per axis, built by projecting known parallel world edges.
    def lines(direction, offsets):
        out = []
        for off in offsets:
            a = np.array(off, float)
            b = a + np.array(direction, float) * 4.0
            uv, visible = cam.project(np.stack([a, b]))
            assert visible.all()
            out.append([[float(uv[0][0]), float(uv[0][1])], [float(uv[1][0]), float(uv[1][1])]])
        return out

    control = {
        "axisA": lines((1, 0, 0), [(-2, 0, 1), (-2, 0, 4)]),
        "axisB": lines((0, 0, 1), [(-2, 0, 0), (2, 0, 0)]),
        "origin": [480.0, 600.0],
    }
    resp = client.put(
        f"/api/projects/{project['id']}/solve",
        json={"controlPoints": control, "cameraHeight": 1.6},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_health_reports_backends(client):
    body = client.get("/api/health").json()
    assert body["ok"]
    assert body["backends"]["depth"]["fallback"] == "planar-room"
    assert body["backends"]["generate"]["fallback"] == "proxy-reprojection"


def test_upload_rejects_non_images(client):
    resp = client.post("/api/projects", files={"file": ("x.txt", b"not an image", "text/plain")})
    assert resp.status_code == 400


def test_full_pipeline(client):
    project = make_project(client)
    assert project["step"] == "solve"
    assert project["image"]["width"] == 960

    # --- Step 2: automatic solve suggestion, then a confirmed solve ---------
    control = wait(client, client.post(f"/api/projects/{project['id']}/solve/auto"))
    assert set(control) >= {"axisA", "axisB", "origin"}

    state = confirm_solve(client, project)
    assert state["solve"]["confirmed"] is True
    assert state["step"] == "proxy"
    cam = state["solve"]["camera"]
    assert cam["focal_px"] == pytest.approx(truth_camera().focal_px, rel=0.02)
    assert cam["position"][1] == pytest.approx(1.6)

    # The live preview endpoint must agree with what was stored.
    preview = client.post(
        f"/api/projects/{project['id']}/solve/preview",
        json={
            "controlPoints": state["solve"]["controlPoints"],
            "cameraHeight": state["solve"]["cameraHeight"],
        },
    ).json()
    assert preview["camera"]["focal_px"] == pytest.approx(cam["focal_px"])
    assert len(preview["grid"]) > 4

    # --- Step 3: proxy -----------------------------------------------------
    proxy = wait(client, client.post(f"/api/projects/{project['id']}/proxy", json={}))
    assert proxy["confirmed"] is False
    assert any(p["kind"] == "plane" for p in proxy["primitives"])
    depth_asset = client.get(f"/api/projects/{project['id']}/asset/depth.png")
    assert depth_asset.status_code == 200

    edited = [p for p in proxy["primitives"] if p["id"] != "prim-000"]
    edited.append(
        {
            "id": "user-1", "kind": "box", "position": [0.0, 0.4, 2.0],
            "size": [0.8, 0.8, 0.8], "rotationY": 0.2, "label": "added",
            "color": "#cc8844", "source": "manual", "hidden": False,
        }
    )
    state = client.put(
        f"/api/projects/{project['id']}/proxy", json={"primitives": edited}
    ).json()
    assert state["proxy"]["confirmed"] is True
    assert state["step"] == "bodies"
    assert any(p["id"] == "user-1" for p in state["proxy"]["primitives"])

    # --- Step 4: bodies ----------------------------------------------------
    bodies = wait(client, client.post(f"/api/projects/{project['id']}/bodies"))
    assert bodies["backend"] in ("manual", "keypoint-rcnn", "hmr2")

    truth = truth_camera()
    foot = np.array([0.4, 0.0, 2.2])
    uv, _ = truth.project(np.stack([foot, foot + [0, 1.75, 0]]))
    placed = client.post(
        f"/api/projects/{project['id']}/bodies/from-box",
        json={"bbox": [uv[1][0] - 35, uv[1][1], uv[0][0] + 35, uv[0][1]], "id": "person-1"},
    ).json()["body"]
    assert placed["height"] == pytest.approx(1.75, abs=0.02)
    assert placed["position"][0] == pytest.approx(0.4, abs=0.03)

    state = client.put(
        f"/api/projects/{project['id']}/bodies", json={"bodies": [placed]}
    ).json()
    assert state["bodies"]["confirmed"] is True
    assert state["step"] == "navigate"

    # --- Steps 5 and 6: lock an angle and render it ------------------------
    def png(colour):
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), colour).save(buf, format="PNG")
        return buf.getvalue()

    shot_camera = {"position": [1.0, 1.5, 6.0], "quaternion": [0, 0, 0, 1], "fov": 45}
    shot = wait(
        client,
        client.post(
            f"/api/projects/{project['id']}/shots",
            data={"camera": json.dumps(shot_camera), "settings": json.dumps({"steps": 4})},
            files={
                "depth": ("d.png", png((10, 10, 10)), "image/png"),
                "normal": ("n.png", png((128, 128, 255)), "image/png"),
                "preview": ("p.png", png((80, 90, 100)), "image/png"),
            },
        ),
    )
    assert shot["backend"] == "proxy-reprojection"
    assert client.get(f"/api/projects/{project['id']}/asset/{shot['result']}").status_code == 200

    final = client.get(f"/api/projects/{project['id']}").json()
    assert final["step"] == "render"
    assert len(final["shots"]) == 1


def test_going_back_keeps_confirmed_work(client):
    project = make_project(client)
    state = confirm_solve(client, project)
    wait(client, client.post(f"/api/projects/{project['id']}/proxy", json={}))
    state = client.get(f"/api/projects/{project['id']}").json()
    client.put(
        f"/api/projects/{project['id']}/proxy",
        json={"primitives": state["proxy"]["primitives"]},
    )

    # Stepping back is just a pointer move: nothing recomputes, nothing is lost.
    back = client.put(f"/api/projects/{project['id']}/step", json={"step": "solve"}).json()
    assert back["step"] == "solve"
    assert back["solve"]["confirmed"] is True
    assert back["proxy"]["confirmed"] is True
    assert back["proxy"]["primitives"]


def test_reconfirming_the_same_solve_keeps_the_proxy(client):
    project = make_project(client)
    confirm_solve(client, project)
    wait(client, client.post(f"/api/projects/{project['id']}/proxy", json={}))
    state = client.get(f"/api/projects/{project['id']}").json()
    client.put(
        f"/api/projects/{project['id']}/proxy",
        json={"primitives": state["proxy"]["primitives"]},
    )

    again = confirm_solve(client, project)
    assert again["cleared"] == []
    assert again["proxy"] is not None, "an unchanged camera must not discard the proxy"


def test_moving_the_camera_clears_downstream_work(client):
    project = make_project(client)
    confirm_solve(client, project)
    wait(client, client.post(f"/api/projects/{project['id']}/proxy", json={}))
    state = client.get(f"/api/projects/{project['id']}").json()
    client.put(
        f"/api/projects/{project['id']}/proxy",
        json={"primitives": state["proxy"]["primitives"]},
    )

    moved = client.put(
        f"/api/projects/{project['id']}/solve",
        json={
            "controlPoints": state["solve"]["controlPoints"],
            "cameraHeight": 2.4,
        },
    ).json()
    assert "proxy" in moved["cleared"]
    assert moved["proxy"] is None


def test_solve_rejects_parallel_control_lines(client):
    project = make_project(client)
    resp = client.put(
        f"/api/projects/{project['id']}/solve",
        json={
            "controlPoints": {
                "axisA": [[[0, 0], [100, 0]], [[0, 50], [100, 50]]],
                "axisB": [[[0, 0], [0, 100]], [[50, 0], [50, 100]]],
                "origin": [480, 600],
            },
            "cameraHeight": 1.6,
        },
    )
    assert resp.status_code == 400
    assert "parallel" in resp.json()["detail"]


def test_proxy_before_solve_is_a_conflict(client):
    project = make_project(client)
    resp = client.post(f"/api/projects/{project['id']}/proxy", json={})
    assert resp.status_code == 409


def test_unknown_project_is_404(client):
    assert client.get("/api/projects/doesnotexist").status_code == 404


def test_asset_path_traversal_is_refused(client):
    project = make_project(client)
    resp = client.get(f"/api/projects/{project['id']}/asset/../../../etc/passwd")
    assert resp.status_code == 404
