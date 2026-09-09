/**
 * Step 2: the fSpy-style perspective solve.
 *
 * Four control lines -- two per horizontal axis -- and an origin handle on the
 * floor.  Each pair defines a vanishing point; the two vanishing points give
 * the focal length and the orientation, and the origin handle plus the camera
 * height give the position.  Everything is recomputed on every pointer move so
 * the ground grid tracks the lines as they are dragged.
 */

import { api, runJob } from '../api';
import {
  groundGridSegments,
  horizonY,
  solveFromControlPoints,
  vanishingPoint,
} from '../solve';
import { store } from '../store';
import type { CameraSolve, ControlLine, ControlPoints, Point } from '../types';
import { button, clamp, el, slider } from '../ui/dom';
import { PhotoFrame } from '../ui/photoFrame';
import { stepLayout } from '../ui/shell';

const AXIS_COLORS = { axisA: '#ff6b6b', axisB: '#4ade80' } as const;
const HANDLE_HIT_PX = 24;

type AxisKey = 'axisA' | 'axisB';

interface Handle {
  kind: 'endpoint' | 'line' | 'origin';
  axis?: AxisKey;
  line?: number;
  end?: 0 | 1;
}

function defaultControlPoints(width: number, height: number): ControlPoints {
  const w = width;
  const h = height;
  return {
    axisA: [
      [
        [0.12 * w, 0.72 * h],
        [0.46 * w, 0.6 * h],
      ],
      [
        [0.12 * w, 0.92 * h],
        [0.46 * w, 0.74 * h],
      ],
    ],
    axisB: [
      [
        [0.88 * w, 0.72 * h],
        [0.54 * w, 0.6 * h],
      ],
      [
        [0.88 * w, 0.92 * h],
        [0.54 * w, 0.74 * h],
      ],
    ],
    origin: [0.5 * w, 0.82 * h],
  };
}

const clone = (c: ControlPoints): ControlPoints => ({
  axisA: c.axisA.map((l) => [[...l[0]], [...l[1]]]) as ControlLine[],
  axisB: c.axisB.map((l) => [[...l[0]], [...l[1]]]) as ControlLine[],
  origin: [...c.origin] as Point,
  auto: c.auto,
  segmentCount: c.segmentCount,
});

export function renderSolve(container: HTMLElement): () => void {
  const project = store.get().project;
  if (!project) {
    store.goTo('upload');
    return () => undefined;
  }

  const { width, height } = project.image;
  const { root, stage, controls } = stepLayout();
  container.append(root);

  const frame = new PhotoFrame(stage, width, height, api.imageUrl(project));

  // Corrections survive going back: a draft beats the confirmed solve, which
  // beats a plain default.
  const draft = store.get().drafts.solve;
  let control: ControlPoints =
    draft?.controlPoints ??
    (project.solve ? clone(project.solve.controlPoints) : defaultControlPoints(width, height));
  let cameraHeight = draft?.cameraHeight ?? project.solve?.cameraHeight ?? 1.6;
  let gridSpacing = 1;
  let showGrid = true;

  let camera: CameraSolve | null = null;
  let solveError: string | null = null;
  let dragging: Handle | null = null;
  let dragOffset: Point = [0, 0];

  const readout = el('div', { class: 'readout' });
  const overlayBox = el('div', { class: 'stage-overlay' }, readout);
  stage.append(overlayBox);

  const recompute = () => {
    const result = solveFromControlPoints(width, height, control, cameraHeight);
    if (result.camera) {
      camera = result.camera;
      solveError = null;
    } else {
      // Keep drawing the last good camera so the grid does not disappear
      // mid-drag; the message tells the user what to fix.
      solveError = result.error;
    }
  };

  const draw = () => {
    const ctx = frame.overlayContext();
    if (!ctx) return;
    const px = 1 / frame.getRect().scale; // one screen pixel in image units
    const diagonal = Math.hypot(width, height);

    if (camera && showGrid && !solveError) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.42)';
      ctx.lineWidth = 1.1 * px;
      for (const polyline of groundGridSegments(camera, 14, gridSpacing)) {
        ctx.beginPath();
        polyline.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
        ctx.stroke();
      }
      ctx.restore();
    }

    if (camera) {
      const y0 = horizonY(camera, 0);
      const y1 = horizonY(camera, width);
      if (y0 !== null && y1 !== null) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.setLineDash([9 * px, 7 * px]);
        ctx.lineWidth = 1.2 * px;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(width, y1);
        ctx.stroke();
        ctx.restore();
      }
    }

    (['axisA', 'axisB'] as AxisKey[]).forEach((axis) => {
      const color = AXIS_COLORS[axis];
      const vp = vanishingPoint(control[axis][0], control[axis][1], diagonal);
      control[axis].forEach((line) => {
        // The dashed tail shows where the line is heading, which is how you
        // tell whether it is really following an edge of the scene.
        if (vp) {
          ctx.save();
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.28;
          ctx.setLineDash([7 * px, 6 * px]);
          ctx.lineWidth = 1 * px;
          ctx.beginPath();
          ctx.moveTo(line[1][0], line[1][1]);
          ctx.lineTo(vp[0], vp[1]);
          ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4 * px;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(line[0][0], line[0][1]);
        ctx.lineTo(line[1][0], line[1][1]);
        ctx.stroke();
        for (const [u, v] of line) {
          ctx.beginPath();
          ctx.arc(u, v, 7 * px, 0, Math.PI * 2);
          ctx.fillStyle = '#0e1116';
          ctx.fill();
          ctx.lineWidth = 2 * px;
          ctx.stroke();
        }
        ctx.restore();
      });
    });

    const [ou, ov] = control.origin;
    ctx.save();
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 2.2 * px;
    ctx.beginPath();
    ctx.arc(ou, ov, 10 * px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ou - 16 * px, ov);
    ctx.lineTo(ou + 16 * px, ov);
    ctx.moveTo(ou, ov - 16 * px);
    ctx.lineTo(ou, ov + 16 * px);
    ctx.stroke();
    ctx.restore();
  };

  const refreshReadout = () => {
    if (solveError) {
      readout.textContent = solveError;
      readout.style.color = 'var(--warn)';
      return;
    }
    if (!camera) {
      readout.textContent = 'Drag the lines onto two perpendicular edges.';
      return;
    }
    readout.style.color = '';
    const equiv35 = (camera.focal_px * 36) / width;
    readout.textContent =
      `${equiv35.toFixed(0)} mm equivalent  -  ` +
      `${camera.vfovDeg.toFixed(1)} deg vertical  -  ` +
      `camera ${cameraHeight.toFixed(2)} m up`;
  };

  const update = () => {
    recompute();
    draw();
    refreshReadout();
    confirmButton.disabled = !camera || solveError !== null;
  };

  // --- dragging -----------------------------------------------------------

  const hitTest = (u: number, v: number): Handle | null => {
    const tolerance = HANDLE_HIT_PX / frame.getRect().scale;
    const candidates: { handle: Handle; distance: number }[] = [];
    const consider = (handle: Handle, x: number, y: number) => {
      const distance = Math.hypot(x - u, y - v);
      if (distance <= tolerance) candidates.push({ handle, distance });
    };

    consider({ kind: 'origin' }, control.origin[0], control.origin[1]);
    (['axisA', 'axisB'] as AxisKey[]).forEach((axis) => {
      control[axis].forEach((line, index) => {
        consider({ kind: 'endpoint', axis, line: index, end: 0 }, line[0][0], line[0][1]);
        consider({ kind: 'endpoint', axis, line: index, end: 1 }, line[1][0], line[1][1]);
      });
    });
    if (candidates.length) {
      return candidates.reduce((a, b) => (b.distance < a.distance ? b : a)).handle;
    }

    // Nothing on a handle: grabbing the body of a line moves the whole line.
    for (const axis of ['axisA', 'axisB'] as AxisKey[]) {
      for (let index = 0; index < control[axis].length; index += 1) {
        const [a, b] = control[axis][index];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const lengthSq = abx * abx + aby * aby;
        if (lengthSq < 1e-6) continue;
        const t = clamp(((u - a[0]) * abx + (v - a[1]) * aby) / lengthSq, 0, 1);
        const d = Math.hypot(a[0] + t * abx - u, a[1] + t * aby - v);
        if (d <= tolerance) return { kind: 'line', axis, line: index };
      }
    }
    return null;
  };

  const onPointerDown = (event: PointerEvent) => {
    const [u, v] = frame.toImage(event.clientX, event.clientY);
    const handle = hitTest(u, v);
    if (!handle) return;
    dragging = handle;
    if (handle.kind === 'origin') {
      dragOffset = [control.origin[0] - u, control.origin[1] - v];
    } else if (handle.kind === 'line') {
      const line = control[handle.axis!][handle.line!];
      dragOffset = [line[0][0] - u, line[0][1] - v];
    } else {
      const point = control[handle.axis!][handle.line!][handle.end!];
      dragOffset = [point[0] - u, point[1] - v];
    }
    frame.overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    const [u, v] = frame.toImage(event.clientX, event.clientY);
    const x = u + dragOffset[0];
    const y = v + dragOffset[1];

    if (dragging.kind === 'origin') {
      control.origin = [clamp(x, 0, width), clamp(y, 0, height)];
    } else if (dragging.kind === 'line') {
      const line = control[dragging.axis!][dragging.line!];
      const dx = x - line[0][0];
      const dy = y - line[0][1];
      control[dragging.axis!][dragging.line!] = [
        [line[0][0] + dx, line[0][1] + dy],
        [line[1][0] + dx, line[1][1] + dy],
      ];
    } else {
      // Endpoints may leave the frame: a vanishing point often sits far
      // outside the photo and the line has to be able to point at it.
      const span = Math.max(width, height);
      control[dragging.axis!][dragging.line!][dragging.end!] = [
        clamp(x, -span, width + span),
        clamp(y, -span, height + span),
      ];
    }
    update();
    event.preventDefault();
  };

  const endDrag = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = null;
    if (frame.overlay.hasPointerCapture(event.pointerId)) {
      frame.overlay.releasePointerCapture(event.pointerId);
    }
    store.setDraftQuietly('solve', { controlPoints: clone(control), cameraHeight });
  };

  frame.overlay.addEventListener('pointerdown', onPointerDown);
  frame.overlay.addEventListener('pointermove', onPointerMove);
  frame.overlay.addEventListener('pointerup', endDrag);
  frame.overlay.addEventListener('pointercancel', endDrag);
  const unlisten = frame.onLayout(() => draw());

  // --- controls -----------------------------------------------------------

  const autoButton = button('Auto-detect lines', () => void runAuto(), { class: 'btn' });
  const confirmButton = button('Confirm perspective', () => void confirm(), {
    class: 'btn-primary',
  });

  const runAuto = async () => {
    const handle = runJob<ControlPoints>(
      () => api.autoSolve(project.id),
      ({ progress, message }) => store.updateBusy({ progress, message }),
    );
    store.setBusy({
      label: 'Detecting vanishing lines',
      progress: 0,
      message: '',
      cancel: handle.cancel,
    });
    try {
      const detected = await handle.promise;
      control = clone({ ...detected, origin: detected.origin ?? control.origin });
      store.setDraftQuietly('solve', { controlPoints: clone(control), cameraHeight });
      update();
      store.notify(
        detected.auto ? 'info' : 'warn',
        detected.auto
          ? `Found two vanishing points from ${detected.segmentCount ?? 0} straight edges. Nudge them if the grid looks off.`
          : 'Not enough straight edges to solve automatically. Drag the four lines onto two perpendicular directions.',
      );
    } catch (error) {
      if ((error as Error).message !== 'Cancelled') {
        store.notify('error', (error as Error).message);
      }
    } finally {
      store.setBusy(null);
    }
  };

  const confirm = async () => {
    if (!camera || solveError) return;
    store.setBusy({ label: 'Saving the solve', progress: 0.5, message: '' });
    try {
      const updated = await api.confirmSolve(project.id, control, cameraHeight);
      store.applyProject(updated);
      store.clearDraft('solve');
      if (updated.cleared?.length) {
        store.notify(
          'warn',
          `The camera moved, so the ${updated.cleared.join(' and ')} had to be rebuilt.`,
        );
      }
      store.goTo('proxy');
    } catch (error) {
      store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  const gridToggle = button('Hide grid', () => {
    showGrid = !showGrid;
    gridToggle.textContent = showGrid ? 'Hide grid' : 'Show grid';
    draw();
  });

  controls.append(
    el(
      'div',
      { class: 'control-row' },
      slider({
        label: 'Camera height',
        min: 0.3,
        max: 4,
        step: 0.01,
        value: cameraHeight,
        format: (v) => `${v.toFixed(2)} m`,
        onInput: (value) => {
          cameraHeight = value;
          store.setDraftQuietly('solve', { controlPoints: clone(control), cameraHeight });
          update();
        },
      }),
      slider({
        label: 'Grid spacing',
        min: 0.25,
        max: 2,
        step: 0.25,
        value: gridSpacing,
        format: (v) => `${v.toFixed(2)} m`,
        onInput: (value) => {
          gridSpacing = value;
          draw();
        },
      }),
    ),
    el('p', {
      class: 'hint',
      html:
        '<strong>Red</strong> and <strong>green</strong> lines follow two perpendicular ' +
        'horizontal directions -- floor edges, skirting boards, table edges. Drag their ' +
        'ends onto real edges; drag the middle to slide a whole line. The ' +
        '<strong>orange cross</strong> is the world origin and must sit on the floor. ' +
        'Everything downstream is measured in metres from it, so set the camera height ' +
        'to get the scale right.',
    }),
    el(
      'div',
      { class: 'control-row' },
      autoButton,
      gridToggle,
      el('span', { class: 'spacer' }),
      confirmButton,
    ),
  );

  update();
  if (!draft && !project.solve) void runAuto();

  return () => {
    unlisten();
    frame.overlay.removeEventListener('pointerdown', onPointerDown);
    frame.overlay.removeEventListener('pointermove', onPointerMove);
    frame.overlay.removeEventListener('pointerup', endDrag);
    frame.overlay.removeEventListener('pointercancel', endDrag);
    frame.dispose();
  };
}
