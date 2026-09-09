"""Step 6: regenerate the photo from the locked angle.

The original photograph is the image-to-image source; the depth and normal
buffers rendered from the proxy scene at the new angle are the control signals.
Three backends are supported, tried in the order the configuration asks for:

* ``diffusers`` -- a local Stable Diffusion + ControlNet pipeline.
* ``a1111``     -- the AUTOMATIC1111 web UI API with the ControlNet extension.
* ``none``      -- no generator, so the projective re-render the browser already
  produced from the proxy is returned as the result.  It is a real new view of
  the scene, just an unpolished one, which keeps the whole flow usable with no
  GPU at all.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass

from .. import config

DEFAULT_PROMPT = (
    "the same room photographed from a new camera position, same furniture, "
    "same people, same daylight and colour grade, photorealistic interior "
    "photograph, natural perspective, sharp focus"
)
DEFAULT_NEGATIVE = (
    "different room, extra people, deformed hands, warped furniture, text, "
    "watermark, cartoon, illustration, blurry, oversaturated"
)


@dataclass
class GenerationRequest:
    source_png: bytes
    depth_png: bytes
    normal_png: bytes
    preview_png: bytes | None = None
    prompt: str = DEFAULT_PROMPT
    negative_prompt: str = DEFAULT_NEGATIVE
    strength: float = 0.72
    guidance: float = 7.0
    steps: int = 30
    seed: int = -1
    depth_weight: float = 1.0
    normal_weight: float = 0.6


@dataclass
class GenerationResult:
    png: bytes
    backend: str
    note: str = ""
    seed: int | None = None


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _open(data: bytes):
    from PIL import Image

    return Image.open(io.BytesIO(data)).convert("RGB")


def _to_png(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


_pipe_cache: dict[str, object] = {}


def _load_diffusers():
    key = f"{config.GEN_MODEL}|{config.GEN_CONTROLNET_DEPTH}|{config.GEN_CONTROLNET_NORMAL}"
    if key in _pipe_cache:
        return _pipe_cache[key]
    try:
        import torch
        from diffusers import (
            ControlNetModel,
            StableDiffusionControlNetImg2ImgPipeline,
        )
    except Exception:
        _pipe_cache[key] = None
        return None
    try:
        device = config.TORCH_DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if device.startswith("cuda") else torch.float32
        nets = [ControlNetModel.from_pretrained(config.GEN_CONTROLNET_DEPTH, torch_dtype=dtype)]
        if config.GEN_CONTROLNET_NORMAL:
            nets.append(
                ControlNetModel.from_pretrained(config.GEN_CONTROLNET_NORMAL, torch_dtype=dtype)
            )
        pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
            config.GEN_MODEL,
            controlnet=nets if len(nets) > 1 else nets[0],
            torch_dtype=dtype,
            safety_checker=None,
        ).to(device)
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        _pipe_cache[key] = None
        return None
    _pipe_cache[key] = (pipe, len(nets))
    return _pipe_cache[key]


def _run_diffusers(req: GenerationRequest, report) -> GenerationResult | None:
    loaded = _load_diffusers()
    if loaded is None:
        return None
    import torch

    pipe, n_nets = loaded
    source = _open(req.source_png)
    depth = _open(req.depth_png).resize(source.size)
    normal = _open(req.normal_png).resize(source.size)
    controls = [depth, normal][:n_nets]
    scales = [req.depth_weight, req.normal_weight][:n_nets]

    seed = req.seed if req.seed >= 0 else int(torch.seed() % (2**31))
    generator = torch.Generator(device=pipe.device.type).manual_seed(seed)

    def on_step(_pipe, step, _timestep, kwargs):
        report(0.25 + 0.7 * (step / max(req.steps, 1)), f"Diffusing {step}/{req.steps}")
        return kwargs

    report(0.2, "Running ControlNet img2img")
    out = pipe(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        image=source,
        control_image=controls if n_nets > 1 else controls[0],
        controlnet_conditioning_scale=scales if n_nets > 1 else scales[0],
        strength=req.strength,
        guidance_scale=req.guidance,
        num_inference_steps=req.steps,
        generator=generator,
        callback_on_step_end=on_step,
    )
    return GenerationResult(
        _to_png(out.images[0]),
        f"diffusers:{config.GEN_MODEL}",
        seed=seed,
    )


def _run_a1111(req: GenerationRequest, report) -> GenerationResult | None:
    try:
        import httpx
    except Exception:
        return None
    base = config.A1111_URL.rstrip("/")
    controls = [
        {"image": _b64(req.depth_png), "module": "none", "weight": req.depth_weight},
        {"image": _b64(req.normal_png), "module": "none", "weight": req.normal_weight},
    ]
    payload = {
        "init_images": [_b64(req.source_png)],
        "prompt": req.prompt,
        "negative_prompt": req.negative_prompt,
        "denoising_strength": req.strength,
        "cfg_scale": req.guidance,
        "steps": req.steps,
        "seed": req.seed,
        "alwayson_scripts": {
            "controlnet": {
                "args": [
                    {**c, "model": m, "control_mode": "Balanced", "resize_mode": "Just Resize"}
                    for c, m in zip(controls, _a1111_controlnet_models(base))
                    if m
                ]
            }
        },
    }
    try:
        report(0.2, "Sending to the AUTOMATIC1111 API")
        with httpx.Client(timeout=600.0) as client:
            resp = client.post(f"{base}/sdapi/v1/img2img", json=payload)
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return None
    images = data.get("images") or []
    if not images:
        return None
    report(0.9, "Decoding result")
    return GenerationResult(base64.b64decode(images[0]), f"a1111:{base}")


def _a1111_controlnet_models(base: str) -> list[str | None]:
    """Best-guess depth and normal ControlNet model names from the server."""
    try:
        import httpx

        with httpx.Client(timeout=10.0) as client:
            names = client.get(f"{base}/controlnet/model_list").json().get("model_list", [])
    except Exception:
        return [None, None]

    def pick(*words: str) -> str | None:
        for name in names:
            low = name.lower()
            if any(w in low for w in words):
                return name
        return None

    return [pick("depth"), pick("normal")]


def generate(req: GenerationRequest, report=lambda *_: None) -> GenerationResult:
    backend = config.GEN_BACKEND
    order: list[str]
    if backend == "auto":
        order = ["diffusers", "a1111"]
    elif backend == "none":
        order = []
    else:
        order = [backend]

    for name in order:
        report(0.1, f"Trying the {name} backend")
        runner = {"diffusers": _run_diffusers, "a1111": _run_a1111}.get(name)
        if runner is None:
            continue
        result = runner(req, report)
        if result is not None:
            return result
        if backend != "auto":
            raise RuntimeError(
                f"The {name} generation backend was requested but is not "
                f"available.  See reshoot/README.md for how to install it."
            )

    if req.preview_png is None:
        raise RuntimeError(
            "No generation backend is available and the browser did not supply a "
            "proxy re-render to fall back to."
        )
    report(0.9, "Using the proxy re-render")
    return GenerationResult(
        req.preview_png,
        "proxy-reprojection",
        "No diffusion backend is installed, so this is the original photo "
        "re-projected onto the proxy geometry from the new angle.  Install "
        "backend/requirements-ml.txt or point RESHOOT_A1111_URL at a running "
        "AUTOMATIC1111 to get a generated frame.",
    )
