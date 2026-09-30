/** Shapes returned by the Python API.  Kept in step with reshoot/app.py. */

export type StepId = 'upload' | 'solve' | 'proxy' | 'bodies' | 'navigate' | 'render';

export interface CameraSolve {
  width: number;
  height: number;
  focal_px: number;
  principal_point: [number, number];
  /** World -> camera rotation, row major. */
  rotation: number[];
  position: [number, number, number];
  vfovDeg: number;
  aspect: number;
  /** Camera -> world rotation, row major.  What three.js wants. */
  rotationCameraToWorld: number[];
}

export type Point = [number, number];
export type ControlLine = [Point, Point];

export interface ControlPoints {
  axisA: ControlLine[];
  axisB: ControlLine[];
  origin: Point;
  auto?: boolean;
  segmentCount?: number;
}

export interface SolveState {
  controlPoints: ControlPoints;
  cameraHeight: number;
  camera: CameraSolve;
  vanishingPoints: { axisA: Point; axisB: Point };
  confirmed: boolean;
}

export type PrimitiveKind = 'box' | 'cylinder' | 'plane';

export interface Primitive {
  id: string;
  kind: PrimitiveKind;
  position: [number, number, number];
  size: [number, number, number];
  rotationY: number;
  label: string;
  color: string;
  source: string;
  hidden: boolean;
}

export interface ProxyState {
  depth: { file: string; width: number; height: number; backend: string; note: string };
  fit: { scale: number; shift: number; inlierFraction: number };
  stats: Record<string, number>;
  primitives: Primitive[];
  confirmed: boolean;
}

export interface Body {
  id: string;
  bbox: [number, number, number, number];
  position: [number, number, number];
  rotationY: number;
  height: number;
  joints: [number, number, number][];
  parents: number[];
  names: string[];
  keypoints2d: number[][] | null;
  mesh: string | null;
  source: string;
  confidence: number;
}

export interface BodiesState {
  backend: string;
  note: string;
  bodies: Body[];
  confirmed: boolean;
}

export interface ShotCamera {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
}

export interface Shot {
  id: string;
  camera: ShotCamera;
  settings: Record<string, unknown>;
  renders: { depth: string; normal: string; preview: string | null };
  result: string;
  backend: string;
  note: string;
  seed: number | null;
}

export interface Project {
  id: string;
  createdAt: number;
  updatedAt: number;
  step: StepId;
  image: { filename: string; file: string; width: number; height: number };
  solve: SolveState | null;
  proxy: ProxyState | null;
  bodies: BodiesState | null;
  shots: Shot[];
  cleared?: string[];
}

export interface Job<T = unknown> {
  id: string;
  kind: string;
  projectId: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  result: T | null;
  error: string | null;
}

export interface Health {
  ok: boolean;
  backends: {
    depth: { configured: string; depthAnything: boolean; fallback: string };
    humans: {
      configured: string;
      hmr2: boolean;
      keypointRcnn: boolean;
      fallback: string;
    };
    generate: {
      configured: string;
      diffusers: boolean;
      a1111Url: string;
      fallback: string;
    };
  };
}

export interface GenerationSettings {
  prompt: string;
  negativePrompt: string;
  strength: number;
  guidance: number;
  steps: number;
  seed: number;
  depthWeight: number;
  normalWeight: number;
}
