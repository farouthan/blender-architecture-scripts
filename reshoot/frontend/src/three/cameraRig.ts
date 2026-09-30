/**
 * Turning the solved camera into a three.js camera.
 *
 * The conventions were chosen so this is almost a no-op: the solve already
 * works in three.js camera space (x right, y up, looking down -z), so the
 * rotation transfers directly and only the projection needs building by hand,
 * because a solved principal point need not sit at the image centre.
 */

import { Matrix4, PerspectiveCamera, Quaternion } from 'three';
import type { CameraSolve } from '../types';

export const NEAR = 0.05;
export const FAR = 400;

export function quaternionFromSolve(solve: CameraSolve): Quaternion {
  const r = solve.rotationCameraToWorld;
  const m = new Matrix4();
  // Matrix4.set takes arguments in row-major order.
  m.set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
  return new Quaternion().setFromRotationMatrix(m);
}

/**
 * Replace a camera's projection with the exact pinhole one, honouring a
 * principal point that is off centre.
 */
export function applyPinholeProjection(
  camera: PerspectiveCamera,
  solve: CameraSolve,
  near = NEAR,
  far = FAR,
): void {
  const { width: w, height: h, focal_px: f } = solve;
  const [cx, cy] = solve.principal_point;
  const m = camera.projectionMatrix;
  m.set(
    (2 * f) / w, 0, 1 - (2 * cx) / w, 0,
    0, (2 * f) / h, (2 * cy) / h - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  camera.projectionMatrixInverse.copy(m).invert();
}

/** A camera that reproduces the photograph exactly. */
export function cameraFromSolve(solve: CameraSolve): PerspectiveCamera {
  const camera = new PerspectiveCamera(solve.vfovDeg, solve.aspect, NEAR, FAR);
  camera.position.set(solve.position[0], solve.position[1], solve.position[2]);
  camera.quaternion.copy(quaternionFromSolve(solve));
  camera.updateMatrixWorld(true);
  applyPinholeProjection(camera, solve);
  return camera;
}

/**
 * A free camera for step 5, starting where the photograph was taken and using
 * the same lens so the first frame matches the original view.
 */
export function freeCameraFromSolve(solve: CameraSolve): PerspectiveCamera {
  const camera = new PerspectiveCamera(solve.vfovDeg, solve.aspect, NEAR, FAR);
  camera.position.set(solve.position[0], solve.position[1], solve.position[2]);
  camera.quaternion.copy(quaternionFromSolve(solve));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}
