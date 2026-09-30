/**
 * Offscreen render passes.
 *
 * Step 6 needs a depth map and a normal map of the proxy scene as seen from the
 * locked camera, at generation resolution rather than screen resolution, so
 * both are drawn into a render target and read back as PNGs.
 */

import {
  Box3,
  Camera,
  DoubleSide,
  MeshNormalMaterial,
  Scene,
  ShaderMaterial,
  Sphere,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

/**
 * Linear view depth, near mapped to white.
 *
 * ControlNet depth models are trained on MiDaS-style maps where closer is
 * brighter, so the shader inverts the normalised depth rather than writing raw
 * z, and the range is fitted to the scene so the whole 0-255 span is used.
 */
export const depthMaterial = new ShaderMaterial({
  uniforms: { uNear: { value: 0.1 }, uFar: { value: 30.0 } },
  side: DoubleSide,
  vertexShader: /* glsl */ `
    varying float vViewDepth;
    void main() {
      vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
      vViewDepth = -viewPosition.z;
      gl_Position = projectionMatrix * viewPosition;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uNear;
    uniform float uFar;
    varying float vViewDepth;
    void main() {
      float t = clamp((vViewDepth - uNear) / max(uFar - uNear, 1e-4), 0.0, 1.0);
      float v = 1.0 - t;
      gl_FragColor = vec4(v, v, v, 1.0);
    }
  `,
});

export const normalMaterial = new MeshNormalMaterial({ side: DoubleSide });

export interface DepthRange {
  near: number;
  far: number;
}

/** Depth range that just contains the scene as seen from `camera`. */
export function fitDepthRange(scene: Scene, camera: Camera, margin = 1.15): DepthRange {
  const box = new Box3().setFromObject(scene);
  if (box.isEmpty()) return { near: 0.1, far: 30 };
  const sphere = box.getBoundingSphere(new Sphere());
  const distance = camera.getWorldPosition(new Vector3()).distanceTo(sphere.center);
  const near = Math.max(0.1, (distance - sphere.radius) / margin);
  const far = Math.max(near + 0.5, (distance + sphere.radius) * margin);
  return { near, far };
}

/** Render one pass into an offscreen target and read it back as a canvas. */
function renderToCanvas(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
): HTMLCanvasElement {
  const target = new WebGLRenderTarget(width, height);
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);

  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  renderer.setRenderTarget(previousTarget);
  target.dispose();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable, so the control renders cannot be saved');
  const image = ctx.createImageData(width, height);
  // WebGL reads bottom-up; PNG wants top-down.
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 4;
    image.data.set(pixels.subarray(src, src + width * 4), y * width * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode a PNG'))),
      'image/png',
    );
  });
}

export interface ControlRenders {
  depth: Blob;
  normal: Blob;
  depthCanvas: HTMLCanvasElement;
  normalCanvas: HTMLCanvasElement;
  range: DepthRange;
}

/** Depth and normal buffers of the proxy scene from `camera`. */
export async function renderControlBuffers(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
): Promise<ControlRenders> {
  const range = fitDepthRange(scene, camera);
  depthMaterial.uniforms.uNear.value = range.near;
  depthMaterial.uniforms.uFar.value = range.far;

  const previousOverride = scene.overrideMaterial;
  scene.overrideMaterial = depthMaterial;
  const depthCanvas = renderToCanvas(renderer, scene, camera, width, height);
  scene.overrideMaterial = normalMaterial;
  const normalCanvas = renderToCanvas(renderer, scene, camera, width, height);
  scene.overrideMaterial = previousOverride;

  const [depth, normal] = await Promise.all([
    canvasToPng(depthCanvas),
    canvasToPng(normalCanvas),
  ]);
  return { depth, normal, depthCanvas, normalCanvas, range };
}
