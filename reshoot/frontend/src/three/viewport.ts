/**
 * A WebGL viewport: renderer, lights, resize handling and a render loop.
 *
 * Steps 3 and 4 overlay it on the photo with `alpha: true` so the photo shows
 * through; step 5 and the step 6 preview use it opaque.
 */

import {
  AmbientLight,
  Camera,
  DirectionalLight,
  Group,
  HemisphereLight,
  Object3D,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';

export interface Pick {
  id: string;
  kind: string;
  object: Object3D;
  distance: number;
}

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private frameHandle = 0;
  private raycaster = new Raycaster();
  private width = 1;
  private height = 1;

  constructor(options: { alpha?: boolean } = {}) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: options.alpha ?? false,
      preserveDrawingBuffer: true, // step 6 reads the canvas back as a PNG
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, options.alpha ? 0 : 1);
    this.canvas = this.renderer.domElement;
    this.canvas.style.touchAction = 'none';
  }

  setSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera);
  }

  /** Run `frame` every animation frame until `stopLoop`. */
  startLoop(frame: (deltaSeconds: number) => void): void {
    this.stopLoop();
    let previous = performance.now();
    const tick = (now: number) => {
      this.frameHandle = requestAnimationFrame(tick);
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      frame(delta);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stopLoop(): void {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  /**
   * Pick the nearest tagged object under a point given in normalised device
   * coordinates.  Meshes carry their id on the group, so the hit walks up.
   */
  pick(scene: Scene, ndc: Vector2, camera: Camera): Pick | null {
    this.raycaster.setFromCamera(ndc, camera);
    for (const hit of this.raycaster.intersectObjects(scene.children, true)) {
      let node: Object3D | null = hit.object;
      while (node) {
        const data = node.userData as { id?: string; kind?: string };
        if (data.id && data.kind) {
          return { id: data.id, kind: data.kind, object: node, distance: hit.distance };
        }
        node = node.parent;
      }
    }
    return null;
  }

  dispose(): void {
    this.stopLoop();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Neutral lighting so the proxy reads as shape, not as a lighting study. */
export function standardLights(): Group {
  const group = new Group();
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 4);
  const fill = new DirectionalLight(0xa8c4ff, 0.5);
  fill.position.set(-4, 3, -3);
  group.add(
    key,
    fill,
    new HemisphereLight(0xcfe3ff, 0x2a2f38, 0.75),
    new AmbientLight(0xffffff, 0.22),
  );
  return group;
}
