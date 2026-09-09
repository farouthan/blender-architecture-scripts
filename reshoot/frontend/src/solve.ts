/**
 * Browser-side mirror of the Python perspective solve.
 *
 * The server owns the canonical solve, but dragging an axis line has to update
 * the grid at frame rate, so the same maths runs here.  The two implementations
 * are checked against shared fixtures by `npm test`; if you change one, change
 * the other.
 *
 * Conventions match reshoot/backend/reshoot/geometry.py exactly: image pixels
 * with y down, camera space with y up looking down -z, world with y up and the
 * ground plane at y = 0, and `rotation` as the world -> camera matrix in row
 * major order.
 */

import type { CameraSolve, ControlLine, ControlPoints, Point } from './types';

export type Vec3 = [number, number, number];

const INFINITE_VP_DIAGONALS = 1e4;

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function unit(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]);
  if (n < 1e-12) throw new Error('cannot normalise a zero-length vector');
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** Homogeneous line through two image points. */
export function lineThrough(a: Point, b: Point): Vec3 {
  return cross([a[0], a[1], 1], [b[0], b[1], 1]);
}

export function intersect(l1: Vec3, l2: Vec3): Point | null {
  const p = cross(l1, l2);
  if (Math.abs(p[2]) < 1e-9) return null;
  return [p[0] / p[2], p[1] / p[2]];
}

/** Vanishing point of two segments, or null when they are effectively parallel. */
export function vanishingPoint(a: ControlLine, b: ControlLine, diagonal: number): Point | null {
  const p = intersect(lineThrough(a[0], a[1]), lineThrough(b[0], b[1]));
  if (!p) return null;
  if (Math.hypot(p[0], p[1]) > INFINITE_VP_DIAGONALS * diagonal) return null;
  return p;
}

export function pixelRayCam(u: number, v: number, principal: Point, focalPx: number): Vec3 {
  return unit([u - principal[0], -(v - principal[1]), -focalPx]);
}

/**
 * Focal length implied by two orthogonal vanishing points, or null when the
 * configuration is impossible for a real camera.
 */
export function focalFromVanishingPoints(
  vp1: Point,
  vp2: Point,
  principal: Point,
): number | null {
  const fu = [vp1[0] - principal[0], vp1[1] - principal[1]];
  const fv = [vp2[0] - principal[0], vp2[1] - principal[1]];
  const fSq = -(fu[0] * fv[0] + fu[1] * fv[1]);
  if (fSq <= 1) return null;
  return Math.sqrt(fSq);
}

/** World -> camera rotation as three column vectors [xAxis, yAxis, zAxis]. */
export function rotationFromVanishingPoints(
  vpA: Point,
  vpB: Point,
  principal: Point,
  focalPx: number,
): [Vec3, Vec3, Vec3] {
  let x = pixelRayCam(vpA[0], vpA[1], principal, focalPx);
  let z = pixelRayCam(vpB[0], vpB[1], principal, focalPx);
  let y = unit(cross(z, x));
  if (y[1] < 0) {
    z = scale(z, -1);
    y = unit(cross(z, x));
  }
  z = unit(cross(x, y));
  x = unit(cross(y, z));
  return [x, y, z];
}

/** Row-major world -> camera matrix from its three column axes. */
export function matrixFromColumns(cols: [Vec3, Vec3, Vec3]): number[] {
  const [x, y, z] = cols;
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function applyRowMajor(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transposeRowMajor(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export interface SolveResult {
  camera: CameraSolve | null;
  error: string | null;
}

export function solveCamera(
  width: number,
  height: number,
  vpA: Point,
  vpB: Point,
  originPx: Point,
  cameraHeight: number,
  principal?: Point,
  fallbackFocalPx?: number,
): SolveResult {
  const pp: Point = principal ?? [width / 2, height / 2];
  let focal = focalFromVanishingPoints(vpA, vpB, pp);
  if (focal === null) {
    if (fallbackFocalPx === undefined) {
      return {
        camera: null,
        error:
          'The two axis directions are not consistent with a real camera. ' +
          'Drag the lines so they follow two perpendicular edges of the scene.',
      };
    }
    focal = fallbackFocalPx;
  }
  const cols = rotationFromVanishingPoints(vpA, vpB, pp, focal);
  const rotation = matrixFromColumns(cols);
  const cameraToWorld = transposeRowMajor(rotation);

  const dCam = pixelRayCam(originPx[0], originPx[1], pp, focal);
  const dWorld = applyRowMajor(cameraToWorld, dCam);
  if (dWorld[1] > -1e-6) {
    return {
      camera: null,
      error: 'Move the origin handle onto the floor, below the horizon line.',
    };
  }
  const t = -cameraHeight / dWorld[1];
  const position = scale(dWorld, -t);

  return {
    camera: {
      width,
      height,
      focal_px: focal,
      principal_point: pp,
      rotation,
      position,
      vfovDeg: (2 * Math.atan(height / (2 * focal)) * 180) / Math.PI,
      aspect: width / height,
      rotationCameraToWorld: cameraToWorld,
    },
    error: null,
  };
}

/** Solve straight from the fSpy control handles. */
export function solveFromControlPoints(
  width: number,
  height: number,
  control: ControlPoints,
  cameraHeight: number,
  principal?: Point,
): SolveResult & { vanishingPoints?: { axisA: Point; axisB: Point } } {
  const diagonal = Math.hypot(width, height);
  const vpA = vanishingPoint(control.axisA[0], control.axisA[1], diagonal);
  const vpB = vanishingPoint(control.axisB[0], control.axisB[1], diagonal);
  if (!vpA || !vpB) {
    return {
      camera: null,
      error:
        'Two lines of the same colour are parallel, so they have no vanishing ' +
        'point. Give them a little convergence.',
    };
  }
  const result = solveCamera(width, height, vpA, vpB, control.origin, cameraHeight, principal);
  return { ...result, vanishingPoints: { axisA: vpA, axisB: vpB } };
}

export interface Projected {
  u: number;
  v: number;
  visible: boolean;
}

export function project(cam: CameraSolve, p: Vec3): Projected {
  const rel = sub(p, cam.position as Vec3);
  const c = applyRowMajor(cam.rotation, rel);
  const visible = c[2] < -1e-6;
  const denom = visible ? -c[2] : 1;
  return {
    u: cam.principal_point[0] + (cam.focal_px * c[0]) / denom,
    v: cam.principal_point[1] - (cam.focal_px * c[1]) / denom,
    visible,
  };
}

/** World-space direction of the ray through a pixel. */
export function rayThrough(cam: CameraSolve, u: number, v: number): Vec3 {
  const d = pixelRayCam(u, v, cam.principal_point, cam.focal_px);
  return applyRowMajor(cam.rotationCameraToWorld, d);
}

/** Where a pixel's ray meets the ground plane, or null above the horizon. */
export function groundPointAt(cam: CameraSolve, u: number, v: number): Vec3 | null {
  const d = rayThrough(cam, u, v);
  if (d[1] > -1e-9) return null;
  const t = -cam.position[1] / d[1];
  if (t <= 0) return null;
  const c = cam.position as Vec3;
  return [c[0] + t * d[0], c[1] + t * d[1], c[2] + t * d[2]];
}

/** Image row of the horizon at column `u`, or null when it is not a graph. */
export function horizonY(cam: CameraSolve, u: number): number | null {
  const toImage = (d: Vec3): Point | null => {
    const c = applyRowMajor(cam.rotation, d);
    if (Math.abs(c[2]) < 1e-9) return null;
    return [
      cam.principal_point[0] + (cam.focal_px * c[0]) / -c[2],
      cam.principal_point[1] - (cam.focal_px * c[1]) / -c[2],
    ];
  };
  const a = toImage([1, 0, 0]);
  const b = toImage([0, 0, 1]);
  if (!a || !b || Math.abs(b[0] - a[0]) < 1e-9) return null;
  const t = (u - a[0]) / (b[0] - a[0]);
  return a[1] + t * (b[1] - a[1]);
}

/**
 * Ground-plane grid lines projected into the image, split wherever they leave
 * the front of the camera so nothing is drawn across the horizon.
 */
export function groundGridSegments(
  cam: CameraSolve,
  extent = 12,
  spacing = 1,
  samples = 96,
): Point[][] {
  const out: Point[][] = [];
  const n = Math.round(extent / spacing);

  const addPolyline = (make: (t: number) => Vec3) => {
    let run: Point[] = [];
    for (let i = 0; i < samples; i += 1) {
      const t = -extent + (2 * extent * i) / (samples - 1);
      const p = project(cam, make(t));
      const onScreen =
        p.visible &&
        p.u > -4 * cam.width &&
        p.u < 5 * cam.width &&
        p.v > -4 * cam.height &&
        p.v < 5 * cam.height;
      if (onScreen) {
        run.push([p.u, p.v]);
      } else {
        if (run.length > 1) out.push(run);
        run = [];
      }
    }
    if (run.length > 1) out.push(run);
  };

  for (let i = -n; i <= n; i += 1) {
    const c = i * spacing;
    addPolyline((t) => [c, 0, t]);
    addPolyline((t) => [t, 0, c]);
  }
  return out;
}
