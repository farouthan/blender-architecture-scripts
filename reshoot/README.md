# Re-shoot

Re-photograph a scene from a new angle, starting from a single photo.

The app walks through six steps. Each one shows its result and waits for you to
confirm or correct it before moving on, and everything you confirm is saved, so
stepping back never recomputes anything.

| Step | What happens | What you do |
| --- | --- | --- |
| 1. Photo | The photo is stored, EXIF-rotated and normalised. | Drop in an image. |
| 2. Perspective | An fSpy-style two-vanishing-point solve gives focal length, orientation and the ground plane. | Drag four axis lines and the origin handle until the ground grid sits right. |
| 3. Proxy scene | Depth estimation, fitted into the camera frame by scale and shift until the floor pixels land on the ground plane, then clustered into primitives. | Select, move, resize, hide or delete any primitive; add new ones. |
| 4. People | Single-image human recovery places a posed body per person, feet on the floor, scaled to a plausible height. | Nudge position, turn and stature, or draw a box to add someone. |
| 5. New angle | A free camera flies through the proxy scene. | Move the phone, use the two thumbsticks, or drag the scene. Lock the angle. |
| 6. Re-shoot | Depth and normals are rendered from the locked angle and used as ControlNet input, with the original photo as the image-to-image source. | Re-render, re-frame, or tune the generation settings. |

Throughout: a back button on every step, a "new image" action that starts over,
"re-render" and "re-frame" on the final step, and a progress strip that never
blocks the interface -- every heavy pass runs on a worker thread and is polled.

## Running it

```bash
# Backend
cd reshoot/backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py                      # http://localhost:8000

# Frontend
cd reshoot/frontend
npm install
npm run build                      # the backend then serves it at :8000
# or, for development with hot reload:
npm run dev                        # http://localhost:5173, proxying /api to :8000
```

### Using the phone as the camera

Step 5 reads the phone's motion sensors, which browsers only expose on a secure
origin (and, on iOS, only after a permission prompt triggered by a tap). Serve
over TLS and open the app on the phone:

```bash
python run.py --cert cert.pem --key key.pem --port 8443
```

If motion is unavailable the step says so and the thumbsticks and drag-to-orbit
still work on their own.

## Backends

Every heavy stage has a real model backend and a geometric fallback, so the
whole flow works before you install anything. `GET /api/health` reports which
tier is live, and the interface says which one produced each result.

| Stage | Preferred | Fallback |
| --- | --- | --- |
| Depth | Depth Anything V2 (`transformers`) | A room box derived from the solved camera: the floor comes straight from the ground plane, with a back wall above the horizon. |
| People | 4D-Humans / HMR 2.0, else torchvision keypoint R-CNN lifted onto the ground plane | Draw a box per person; the camera solve turns it into a position and a stature. |
| Generation | Stable Diffusion + ControlNet through `diffusers`, or the AUTOMATIC1111 API | The original photo projected onto the proxy geometry from the new camera, with occlusion testing. A real new view, just an unpolished one. |

To install the model backends:

```bash
pip install -r requirements-ml.txt          # torch, transformers, diffusers
pip install git+https://github.com/shubham-goel/4D-Humans.git   # optional
```

### Configuration

All optional, all environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESHOOT_DATA_DIR` | `backend/data` | Where projects are stored. |
| `RESHOOT_WORKING_MAX_EDGE` | `1600` | Longest edge of the working copy of the photo. |
| `RESHOOT_DEPTH_BACKEND` | `auto` | `auto`, `depth-anything`, or `planar`. |
| `RESHOOT_DEPTH_MODEL` | `depth-anything/Depth-Anything-V2-Small-hf` | Depth model id. |
| `RESHOOT_HUMANS_BACKEND` | `auto` | `auto`, `hmr2`, `keypoints`, or `manual`. |
| `RESHOOT_HMR2_CHECKPOINT` | unset | Path to the 4D-Humans checkpoint. |
| `RESHOOT_GEN_BACKEND` | `auto` | `auto`, `diffusers`, `a1111`, or `none`. |
| `RESHOOT_GEN_MODEL` | `stabilityai/stable-diffusion-2-1-base` | Base model for `diffusers`. |
| `RESHOOT_GEN_CONTROLNET_DEPTH` | `thibaud/controlnet-sd21-depth-diffusers` | Depth ControlNet. |
| `RESHOOT_GEN_CONTROLNET_NORMAL` | unset | Normal ControlNet; add one to use both controls. |
| `RESHOOT_A1111_URL` | `http://127.0.0.1:7860` | AUTOMATIC1111 API base. |
| `RESHOOT_TORCH_DEVICE` | auto-detected | Force `cuda`, `cpu`, `mps`. |

## How it fits together

```
backend/reshoot/
  geometry.py     camera solve, projection, ground grid, depth scale/shift fit
  vanishing.py    Canny + probabilistic Hough lines, RANSAC vanishing points
  pipelines/
    depth.py      Depth Anything V2, or a room box from the solved camera
    proxy.py      unprojection, voxel clustering, oriented footprint boxes
    humans.py     HMR 2.0 / keypoints / manual, and the placement maths
    generate.py   diffusers, AUTOMATIC1111, or the browser's re-projection
  store.py        per-project state on disk; confirming a step clears what it invalidates
  jobs.py         thread pool with progress and cancellation
  app.py          the HTTP API

frontend/src/
  solve.ts        browser mirror of the camera solve, for live dragging
  store.ts        step navigation, confirmed state, and per-step drafts
  steps/          one module per step
  three/          camera rig, proxy scene, offscreen passes, projective texturing,
                  thumbsticks, device orientation
```

### Coordinates

Fixed once and used by both sides:

* Image pixels: `u` right, `v` **down**.
* Camera space: `x` right, `y` up, looking down `-z` -- the same as three.js, so
  the solved rotation transfers to the viewer with no conversion.
* World: `y` up, ground plane at `y = 0`, metres.
* `rotation` is world to camera, row major; `rotationCameraToWorld` is its
  transpose, which is what a three.js camera wants.

### Why the solve exists twice

Dragging an axis line has to update the ground grid at frame rate, so the solve
runs in the browser; the server still recomputes it canonically when you
confirm. The two implementations are pinned to each other by
`frontend/test/fixtures.json`: `backend/tests/generate_fixtures.py` writes it, a
pytest fails if Python stops reproducing it, and a node test fails if TypeScript
disagrees by more than floating-point noise.

## Tests

```bash
cd backend  && python -m pytest tests -q     # solve maths, pipelines, full API walk
cd frontend && npm test                      # TypeScript solve vs the Python fixtures
cd frontend && npm run build && npm run test:e2e
```

The end-to-end test drives all six steps in a real browser -- uploading a photo,
solving, building and confirming the proxy, placing a person, locking an angle
and rendering it -- and then checks that stepping back reuses the saved work
instead of recomputing it.
