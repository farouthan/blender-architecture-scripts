/**
 * Step 4: a posed body for each person, standing on the confirmed floor.
 *
 * The recovery backend does what it can -- a full SMPL fit with 4D-Humans, 2D
 * keypoints lifted onto the ground plane with torchvision, or nothing at all --
 * and whatever it returns is placed with the same camera maths.  Either way the
 * bodies are drawn over the photo so a person who is in the wrong spot is
 * obvious, and each one can be nudged, turned, resized or removed.
 */

import { Scene, Vector2 } from 'three';
import { api, runJob } from '../api';
import { store } from '../store';
import type { BodiesState, Body } from '../types';
import { button, clamp, el, slider } from '../ui/dom';
import { PhotoFrame } from '../ui/photoFrame';
import { stepLayout } from '../ui/shell';
import { cameraFromSolve } from '../three/cameraRig';
import { ProxySceneBuilder, applyBodyTransform } from '../three/proxyScene';
import { Viewport, standardLights } from '../three/viewport';

const cloneBodies = (list: Body[]): Body[] =>
  list.map((b) => ({
    ...b,
    bbox: [...b.bbox] as Body['bbox'],
    position: [...b.position] as Body['position'],
    joints: b.joints.map((j) => [...j] as [number, number, number]),
    parents: [...b.parents],
    names: [...b.names],
  }));

export function renderBodies(container: HTMLElement): () => void {
  const project = store.get().project;
  if (!project?.solve?.camera || !project.proxy?.confirmed) {
    store.goTo('proxy');
    return () => undefined;
  }

  const solve = project.solve.camera;
  const { root, stage, controls } = stepLayout();
  container.append(root);

  const frame = new PhotoFrame(stage, project.image.width, project.image.height, api.imageUrl(project));
  const viewport = new Viewport({ alpha: true });
  frame.addLayer(viewport.canvas);
  viewport.canvas.style.opacity = '0.85';
  // The overlay canvas sits under the WebGL layer but owns every pointer here,
  // because the same gesture has to both pick a body and drag a new box.
  viewport.canvas.style.pointerEvents = 'none';

  const builder = new ProxySceneBuilder();
  const scene: Scene = builder.scene;
  scene.background = null;
  scene.add(standardLights());
  builder.setPrimitives(project.proxy.primitives.map((p) => ({ ...p, hidden: true })));
  const camera = cameraFromSolve(solve);

  let bodies: Body[] =
    store.get().drafts.bodies?.bodies ??
    (project.bodies ? cloneBodies(project.bodies.bodies) : []);
  let selectedId: string | null = null;
  let backendNote = project.bodies?.note ?? '';

  const statusLine = el('p', { class: 'hint' });
  const bodyList = el('div', { class: 'object-list' });
  const inspector = el('div', { class: 'card' });

  const saveDraft = () => store.setDraftQuietly('bodies', { bodies: cloneBodies(bodies) });

  const updateStatus = () => {
    statusLine.innerHTML =
      `<strong>${bodies.length}</strong> ${bodies.length === 1 ? 'person' : 'people'} placed.` +
      (backendNote ? ` ${backendNote}` : '');
  };

  const selected = (): Body | undefined => bodies.find((b) => b.id === selectedId);

  const rebuild = () => {
    builder.setBodies(bodies);
    builder.select(selectedId);
    viewport.render(scene, camera);
  };

  const refreshList = () => {
    bodyList.replaceChildren();
    if (!bodies.length) {
      bodyList.append(
        el('span', { class: 'hint', text: 'No people placed yet.' }),
      );
    }
    bodies.forEach((body, index) => {
      const chip = el(
        'button',
        {
          class: 'object-chip',
          type: 'button',
          'data-selected': String(body.id === selectedId),
        },
        `Person ${index + 1} - ${body.height.toFixed(2)} m`,
      );
      chip.addEventListener('click', () => select(body.id));
      bodyList.append(chip);
    });
  };

  const select = (id: string | null) => {
    selectedId = id;
    builder.select(id);
    refreshList();
    refreshInspector();
    viewport.render(scene, camera);
  };

  const mutateSelected = (change: (b: Body) => void, rebuildMesh = false) => {
    const body = selected();
    if (!body) return;
    change(body);
    if (rebuildMesh) {
      // Stature changes the bone geometry, so the rig has to be rebuilt.
      builder.setBodies(bodies);
      builder.select(selectedId);
    } else {
      const entry = builder.get(body.id);
      if (entry) applyBodyTransform(entry.object, body);
    }
    saveDraft();
    viewport.render(scene, camera);
    refreshList();
  };

  const refreshInspector = () => {
    inspector.replaceChildren();
    const body = selected();
    if (!body) {
      inspector.append(
        el('p', {
          class: 'hint',
          text: 'Tap a person to adjust them, or drag a box on the photo to add one.',
        }),
      );
      return;
    }
    inspector.append(
      el(
        'div',
        { class: 'control-row' },
        el('span', { class: 'badge', text: `from ${body.source}` }),
        body.confidence < 1
          ? el('span', {
              class: 'badge',
              text: `${Math.round(body.confidence * 100)}% confident`,
            })
          : null,
      ),
      el(
        'div',
        { class: 'control-row' },
        slider({
          label: 'Along x',
          min: -20,
          max: 20,
          step: 0.01,
          value: body.position[0],
          format: (v) => `${v.toFixed(2)} m`,
          onInput: (value) => mutateSelected((b) => (b.position[0] = value)),
        }),
        slider({
          label: 'Along z',
          min: -20,
          max: 20,
          step: 0.01,
          value: body.position[2],
          format: (v) => `${v.toFixed(2)} m`,
          onInput: (value) => mutateSelected((b) => (b.position[2] = value)),
        }),
        slider({
          label: 'Turn',
          min: -Math.PI,
          max: Math.PI,
          step: 0.01,
          value: body.rotationY,
          format: (v) => `${((v * 180) / Math.PI).toFixed(0)} deg`,
          onInput: (value) => mutateSelected((b) => (b.rotationY = value)),
        }),
        slider({
          label: 'Height',
          min: 1.2,
          max: 2.1,
          step: 0.005,
          value: body.height,
          format: (v) => `${v.toFixed(2)} m`,
          onInput: (value) =>
            mutateSelected((b) => {
              const factor = value / b.height;
              b.height = value;
              b.joints = b.joints.map(
                (j) => [j[0] * factor, j[1] * factor, j[2] * factor] as [number, number, number],
              );
            }, true),
        }),
      ),
      el(
        'div',
        { class: 'control-row' },
        button('Face the camera', () =>
          mutateSelected((b) => {
            b.rotationY = Math.atan2(
              solve.position[0] - b.position[0],
              solve.position[2] - b.position[2],
            );
          }),
        ),
        el('span', { class: 'spacer' }),
        button(
          'Remove',
          () => {
            bodies = bodies.filter((b) => b.id !== body.id);
            selectedId = null;
            saveDraft();
            rebuild();
            refreshList();
            refreshInspector();
            updateStatus();
          },
          { class: 'btn-danger' },
        ),
      ),
    );
  };

  // --- drawing a box to add a person -------------------------------------

  let boxStart: [number, number] | null = null;
  let boxCurrent: [number, number] | null = null;

  const drawOverlay = () => {
    const ctx = frame.overlayContext();
    if (!ctx) return;
    const px = 1 / frame.getRect().scale;
    if (boxStart && boxCurrent) {
      ctx.save();
      ctx.strokeStyle = '#ffb454';
      ctx.setLineDash([8 * px, 6 * px]);
      ctx.lineWidth = 2 * px;
      ctx.strokeRect(
        Math.min(boxStart[0], boxCurrent[0]),
        Math.min(boxStart[1], boxCurrent[1]),
        Math.abs(boxCurrent[0] - boxStart[0]),
        Math.abs(boxCurrent[1] - boxStart[1]),
      );
      ctx.restore();
    }
  };

  const addFromBox = async (bbox: [number, number, number, number]) => {
    try {
      const { body, warning } = await api.bodyFromBox(project.id, bbox);
      bodies = [...bodies, body];
      saveDraft();
      rebuild();
      select(body.id);
      updateStatus();
      if (warning) store.notify('warn', warning);
    } catch (error) {
      store.notify('error', (error as Error).message);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    const [u, v] = frame.toImage(event.clientX, event.clientY);
    const ndc = new Vector2(
      (u / project.image.width) * 2 - 1,
      -((v / project.image.height) * 2 - 1),
    );
    const hit = viewport.pick(scene, ndc, camera);
    if (hit?.kind === 'body') {
      select(hit.id);
      return;
    }
    boxStart = [u, v];
    boxCurrent = [u, v];
    frame.overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!boxStart) return;
    const [u, v] = frame.toImage(event.clientX, event.clientY);
    boxCurrent = [
      clamp(u, 0, project.image.width),
      clamp(v, 0, project.image.height),
    ];
    drawOverlay();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!boxStart || !boxCurrent) return;
    const [x1, y1] = boxStart;
    const [x2, y2] = boxCurrent;
    boxStart = null;
    boxCurrent = null;
    drawOverlay();
    if (frame.overlay.hasPointerCapture(event.pointerId)) {
      frame.overlay.releasePointerCapture(event.pointerId);
    }
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    // A tap, not a drag: treat it as a deselect rather than a zero-size person.
    if (width < 12 || height < 30) {
      select(null);
      return;
    }
    void addFromBox([
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ]);
  };

  frame.overlay.addEventListener('pointerdown', onPointerDown);
  frame.overlay.addEventListener('pointermove', onPointerMove);
  frame.overlay.addEventListener('pointerup', onPointerUp);
  frame.overlay.addEventListener('pointercancel', onPointerUp);

  const unlisten = frame.onLayout((rect) => {
    viewport.setSize(rect.width, rect.height);
    drawOverlay();
    viewport.render(scene, camera);
  });

  // --- detection and confirmation ----------------------------------------

  let proxyVisible = false;
  const detectButton = button('Detect people', () => void detect(), { class: 'btn' });
  const showProxyToggle = button('Show furniture', () => {
    proxyVisible = !proxyVisible;
    showProxyToggle.textContent = proxyVisible ? 'Hide furniture' : 'Show furniture';
    builder.setPrimitives(
      project.proxy!.primitives.map((p) => ({ ...p, hidden: p.hidden || !proxyVisible })),
    );
    builder.select(selectedId);
    viewport.render(scene, camera);
  });

  const confirmButton = button('Confirm people', () => void confirm(), { class: 'btn-primary' });

  const detect = async () => {
    const handle = runJob<BodiesState>(
      () => api.detectBodies(project.id),
      ({ progress, message }) => store.updateBusy({ progress, message }),
    );
    store.setBusy({
      label: 'Recovering bodies',
      progress: 0,
      message: '',
      cancel: handle.cancel,
    });
    try {
      const result = await handle.promise;
      backendNote = result.note;
      if (result.bodies.length) {
        bodies = cloneBodies(result.bodies);
        saveDraft();
        rebuild();
        refreshList();
        select(null);
      }
      updateStatus();
      if (result.note) store.notify(result.bodies.length ? 'info' : 'warn', result.note, 12000);
    } catch (error) {
      if ((error as Error).message !== 'Cancelled') store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  const confirm = async () => {
    store.setBusy({ label: 'Saving the people', progress: 0.5, message: '' });
    try {
      const updated = await api.confirmBodies(project.id, bodies);
      store.applyProject(updated);
      store.clearDraft('bodies');
      store.goTo('navigate');
    } catch (error) {
      store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  controls.append(
    statusLine,
    bodyList,
    inspector,
    el('p', {
      class: 'hint',
      html:
        'Drag a box from the top of a person\'s head to the floor under their feet to add ' +
        'them. The camera solve turns that box into a position and a stature, so the box ' +
        'matters more than it looks: the bottom edge decides where they stand.',
    }),
    el(
      'div',
      { class: 'control-row' },
      detectButton,
      showProxyToggle,
      el('span', { class: 'spacer' }),
      confirmButton,
    ),
  );

  rebuild();
  refreshList();
  refreshInspector();
  updateStatus();
  if (!project.bodies && !store.get().drafts.bodies) void detect();

  return () => {
    unlisten();
    frame.overlay.removeEventListener('pointerdown', onPointerDown);
    frame.overlay.removeEventListener('pointermove', onPointerMove);
    frame.overlay.removeEventListener('pointerup', onPointerUp);
    frame.overlay.removeEventListener('pointercancel', onPointerUp);
    viewport.dispose();
    builder.dispose();
    frame.dispose();
  };
}
