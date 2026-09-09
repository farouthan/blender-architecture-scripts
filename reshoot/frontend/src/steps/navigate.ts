/**
 * Step 5: fly the virtual camera through the proxy scene and lock an angle.
 *
 * Three input paths, usable together: the phone's own motion drives the
 * orientation, two virtual thumbsticks move and look, and dragging on the scene
 * orbits.  The camera starts exactly where the photograph was taken, so the
 * first frame matches the original view and every move is relative to it.
 */

import { Euler, GridHelper, Quaternion, Scene, Vector3 } from 'three';
import { api } from '../api';
import { store } from '../store';
import type { ShotCamera } from '../types';
import { button, clamp, el, slider } from '../ui/dom';
import { stepLayout } from '../ui/shell';
import { freeCameraFromSolve } from '../three/cameraRig';
import {
  DeviceOrientationSource,
  STATUS_MESSAGES,
} from '../three/deviceOrientation';
import { Joypad } from '../three/joypad';
import { ProjectiveTexturer, loadPhotoTexture } from '../three/projective';
import { ProxySceneBuilder } from '../three/proxyScene';
import { Viewport, standardLights } from '../three/viewport';

const MAX_PITCH = Math.PI / 2 - 0.05;
const LOOK_SPEED = 1.9; // radians per second at full stick deflection
const DRAG_SENSITIVITY = 0.0042; // radians per CSS pixel

export function renderNavigate(container: HTMLElement): () => void {
  const project = store.get().project;
  if (!project?.solve?.camera || !project.bodies?.confirmed) {
    store.goTo('bodies');
    return () => undefined;
  }

  const solve = project.solve.camera;
  const { root, stage, controls } = stepLayout();
  container.append(root);

  const viewport = new Viewport();
  stage.append(viewport.canvas);

  const builder = new ProxySceneBuilder();
  const scene: Scene = builder.scene;
  scene.add(standardLights());
  builder.setPrimitives(project.proxy?.primitives ?? []);
  builder.setBodies(project.bodies.bodies);

  const grid = new GridHelper(40, 40, 0x3a4557, 0x232b36);
  grid.position.y = 0.002;
  scene.add(grid);

  const camera = freeCameraFromSolve(solve);

  // Yaw and pitch are tracked separately so look input never rolls the camera.
  const startEuler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  let yaw = startEuler.y;
  let pitch = clamp(startEuler.x, -MAX_PITCH, MAX_PITCH);
  let eyeHeight = camera.position.y;
  let moveSpeed = 1.6;

  const draft = store.get().drafts.navigate;
  if (draft) {
    camera.position.set(...draft.camera.position);
    const q = new Quaternion(...draft.camera.quaternion);
    const e = new Euler().setFromQuaternion(q, 'YXZ');
    yaw = e.y;
    pitch = clamp(e.x, -MAX_PITCH, MAX_PITCH);
    eyeHeight = camera.position.y;
    camera.fov = draft.camera.fov;
    camera.updateProjectionMatrix();
  }

  const moveStick = new Joypad({ side: 'left', caption: 'Move' });
  const lookStick = new Joypad({ side: 'right', caption: 'Look' });
  stage.append(moveStick.element, lookStick.element);

  const readout = el('div', { class: 'readout' });
  const motionReadout = el('div', { class: 'readout' });
  stage.append(el('div', { class: 'stage-overlay' }, readout, motionReadout));

  // --- phone motion -------------------------------------------------------

  const quaternionFromAngles = (y: number, p: number): Quaternion =>
    new Quaternion().setFromEuler(new Euler(p, y, 0, 'YXZ'));

  const motion = new DeviceOrientationSource();
  const deviceQuaternion = new Quaternion();
  const scratchEuler = new Euler();
  let motionActive = false;

  motion.onStatusChange = (status) => {
    motionReadout.textContent = STATUS_MESSAGES[status];
    motionButton.textContent = status === 'running' ? 'Stop phone motion' : 'Use phone as camera';
  };
  motionReadout.textContent = STATUS_MESSAGES.idle;

  const motionButton = button('Use phone as camera', () => void toggleMotion());

  const toggleMotion = async () => {
    if (motion.status === 'running') {
      motion.stop();
      motionActive = false;
      // Keep looking where the phone left off.
      const e = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      yaw = e.y;
      pitch = clamp(e.x, -MAX_PITCH, MAX_PITCH);
      return;
    }
    const status = await motion.start(camera.quaternion);
    if (status === 'running') {
      motionActive = true;
      store.notify('info', 'Move the phone to aim the virtual camera. The sticks still work.');
    } else {
      store.notify('warn', STATUS_MESSAGES[status], 10000);
    }
  };

  // --- drag to orbit ------------------------------------------------------

  let dragPointer: number | null = null;
  let dragLast: [number, number] = [0, 0];

  const onPointerDown = (event: PointerEvent) => {
    if (dragPointer !== null) return;
    dragPointer = event.pointerId;
    dragLast = [event.clientX, event.clientY];
    viewport.canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return;
    const dx = event.clientX - dragLast[0];
    const dy = event.clientY - dragLast[1];
    dragLast = [event.clientX, event.clientY];
    yaw -= dx * DRAG_SENSITIVITY;
    pitch = clamp(pitch - dy * DRAG_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
    // Dragging while the phone is live re-zeroes it to the new aim, so the two
    // inputs combine instead of fighting.
    if (motionActive) motion.recentre(quaternionFromAngles(yaw, pitch));
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== dragPointer) return;
    dragPointer = null;
    if (viewport.canvas.hasPointerCapture(event.pointerId)) {
      viewport.canvas.releasePointerCapture(event.pointerId);
    }
  };

  viewport.canvas.addEventListener('pointerdown', onPointerDown);
  viewport.canvas.addEventListener('pointermove', onPointerMove);
  viewport.canvas.addEventListener('pointerup', onPointerUp);
  viewport.canvas.addEventListener('pointercancel', onPointerUp);

  // --- projected preview --------------------------------------------------

  let projector: ProjectiveTexturer | null = null;
  let showProjection = false;
  const projectionButton = button('Preview with the photo', () => {
    showProjection = !showProjection;
    projectionButton.textContent = showProjection ? 'Show the proxy' : 'Preview with the photo';
    grid.visible = !showProjection;
  });

  void loadPhotoTexture(api.imageUrl(project)).then((texture) => {
    projector = new ProjectiveTexturer(texture);
    const sourceCamera = freeCameraFromSolve(solve);
    grid.visible = false;
    projector.updateSourceDepth(viewport.renderer, scene, sourceCamera);
    grid.visible = !showProjection;
  }).catch(() => store.notify('warn', 'The photo could not be loaded for the projected preview.'));

  // --- the loop -----------------------------------------------------------

  const forward = new Vector3();
  const right = new Vector3();

  const resize = () => {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    viewport.setSize(width, height);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  viewport.startLoop((delta) => {
    const [lookX, lookY] = lookStick.read();
    if (lookX || lookY) {
      yaw -= lookX * LOOK_SPEED * delta;
      pitch = clamp(pitch + lookY * LOOK_SPEED * delta, -MAX_PITCH, MAX_PITCH);
      if (motionActive) motion.recentre(quaternionFromAngles(yaw, pitch));
    }

    if (motionActive && motion.read(deviceQuaternion)) {
      camera.quaternion.copy(deviceQuaternion);
      // Mirror the phone's aim back into yaw and pitch so the readout is live
      // and stopping the phone leaves the camera exactly where it was.
      scratchEuler.setFromQuaternion(camera.quaternion, 'YXZ');
      yaw = scratchEuler.y;
      pitch = clamp(scratchEuler.x, -MAX_PITCH, MAX_PITCH);
    } else {
      camera.quaternion.copy(quaternionFromAngles(yaw, pitch));
    }

    const [strafe, advance] = moveStick.read();
    if (strafe || advance) {
      // Walking stays on the floor plane; height is its own control.
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(Math.sin(yaw), 0, Math.cos(yaw)).negate();
      forward.normalize();
      right.set(forward.z, 0, -forward.x);
      const step = moveSpeed * delta;
      camera.position.addScaledVector(forward, advance * step);
      camera.position.addScaledVector(right, -strafe * step);
    }
    camera.position.y = eyeHeight;

    if (showProjection && projector) projector.render(viewport.renderer, scene, camera);
    else viewport.render(scene, camera);

    readout.textContent =
      `x ${camera.position.x.toFixed(2)}  z ${camera.position.z.toFixed(2)}  ` +
      `eye ${eyeHeight.toFixed(2)} m  heading ${(((-yaw * 180) / Math.PI + 360) % 360).toFixed(0)} deg`;
  });

  // --- controls -----------------------------------------------------------

  const currentShotCamera = (): ShotCamera => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [
      camera.quaternion.x,
      camera.quaternion.y,
      camera.quaternion.z,
      camera.quaternion.w,
    ],
    fov: camera.fov,
  });

  const resetButton = button('Back to the original angle', () => {
    const original = freeCameraFromSolve(solve);
    camera.position.copy(original.position);
    const e = new Euler().setFromQuaternion(original.quaternion, 'YXZ');
    yaw = e.y;
    pitch = clamp(e.x, -MAX_PITCH, MAX_PITCH);
    eyeHeight = original.position.y;
    heightSlider.reset(eyeHeight);
    if (motionActive) motion.recentre(quaternionFromAngles(yaw, pitch));
  });

  const lockButton = button('Lock this angle', () => {
    store.setDraft('navigate', { camera: currentShotCamera() });
    store.goTo('render');
  }, { class: 'btn-primary' });

  const makeHeightSlider = () => {
    let input: HTMLInputElement | null = null;
    const node = slider({
      label: 'Eye height',
      min: 0.2,
      max: 6,
      step: 0.01,
      value: eyeHeight,
      format: (v) => `${v.toFixed(2)} m`,
      onInput: (value) => {
        eyeHeight = value;
      },
    });
    input = node.querySelector('input');
    return {
      node,
      reset(value: number) {
        eyeHeight = value;
        if (input) {
          input.value = String(value);
          input.dispatchEvent(new Event('input'));
        }
      },
    };
  };
  const heightSlider = makeHeightSlider();

  controls.append(
    el(
      'div',
      { class: 'control-row' },
      heightSlider.node,
      slider({
        label: 'Move speed',
        min: 0.3,
        max: 6,
        step: 0.1,
        value: moveSpeed,
        format: (v) => `${v.toFixed(1)} m/s`,
        onInput: (value) => (moveSpeed = value),
      }),
      slider({
        label: 'Lens',
        min: 15,
        max: 100,
        step: 1,
        value: camera.fov,
        format: (v) => `${v.toFixed(0)} deg`,
        onInput: (value) => {
          camera.fov = value;
          camera.updateProjectionMatrix();
        },
      }),
    ),
    el('p', {
      class: 'hint',
      html:
        'The <strong>left stick</strong> walks, the <strong>right stick</strong> looks, and ' +
        'dragging on the scene turns the camera. Hand the phone the camera to aim it by ' +
        'moving the phone itself; the sticks keep working alongside it.',
    }),
    el(
      'div',
      { class: 'control-row' },
      motionButton,
      projectionButton,
      resetButton,
      el('span', { class: 'spacer' }),
      lockButton,
    ),
  );

  return () => {
    observer.disconnect();
    viewport.canvas.removeEventListener('pointerdown', onPointerDown);
    viewport.canvas.removeEventListener('pointermove', onPointerMove);
    viewport.canvas.removeEventListener('pointerup', onPointerUp);
    viewport.canvas.removeEventListener('pointercancel', onPointerUp);
    motion.stop();
    moveStick.dispose();
    lookStick.dispose();
    projector?.dispose();
    viewport.dispose();
    builder.dispose();
  };
}
