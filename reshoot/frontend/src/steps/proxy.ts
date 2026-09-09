/**
 * Step 3: depth estimation fitted into the confirmed camera frame, shown as a
 * primitive proxy overlaid on the photo.
 *
 * The overlay is the check that matters: because the virtual camera reproduces
 * the real one, a primitive that is in the right place lands exactly on the
 * object it stands for.  Anything that does not line up can be nudged, resized,
 * hidden or deleted, and new primitives can be dropped onto the floor.
 */

import { Mesh, Scene, Vector2 } from 'three';
import { api, runJob } from '../api';
import { groundPointAt } from '../solve';
import { store } from '../store';
import type { Primitive, ProxyState } from '../types';
import { button, el, slider } from '../ui/dom';
import { PhotoFrame } from '../ui/photoFrame';
import { stepLayout } from '../ui/shell';
import { cameraFromSolve } from '../three/cameraRig';
import {
  ProxySceneBuilder,
  applyPrimitiveGeometry,
} from '../three/proxyScene';
import { Viewport, standardLights } from '../three/viewport';

const clonePrimitives = (list: Primitive[]): Primitive[] =>
  list.map((p) => ({ ...p, position: [...p.position], size: [...p.size] })) as Primitive[];

export function renderProxy(container: HTMLElement): () => void {
  const project = store.get().project;
  if (!project?.solve?.camera) {
    store.goTo('solve');
    return () => undefined;
  }

  const solve = project.solve.camera;
  const { root, stage, controls } = stepLayout();
  container.append(root);

  const frame = new PhotoFrame(stage, project.image.width, project.image.height, api.imageUrl(project));
  const viewport = new Viewport({ alpha: true });
  frame.addLayer(viewport.canvas);
  viewport.canvas.style.opacity = '0.72';

  const builder = new ProxySceneBuilder();
  const scene: Scene = builder.scene;
  scene.background = null;
  scene.add(standardLights());
  const camera = cameraFromSolve(solve);

  let primitives: Primitive[] =
    store.get().drafts.proxy?.primitives ??
    (project.proxy ? clonePrimitives(project.proxy.primitives) : []);
  let selectedId: string | null = null;
  let overlayOpacity = 0.72;

  const inspector = el('div', { class: 'card' });
  const objectList = el('div', { class: 'object-list' });
  const statusLine = el('p', { class: 'hint' });

  const saveDraft = () => store.setDraftQuietly('proxy', { primitives: clonePrimitives(primitives) });

  const rebuildScene = () => {
    builder.setPrimitives(primitives);
    builder.select(selectedId);
    viewport.render(scene, camera);
  };

  const selected = (): Primitive | undefined => primitives.find((p) => p.id === selectedId);

  const refreshList = () => {
    objectList.replaceChildren();
    if (!primitives.length) {
      objectList.append(
        el('span', { class: 'hint', text: 'No primitives yet. Build the proxy to fill this in.' }),
      );
    }
    for (const primitive of primitives) {
      const chip = el(
        'button',
        {
          class: 'object-chip',
          type: 'button',
          'data-selected': String(primitive.id === selectedId),
          'data-hidden': String(primitive.hidden),
        },
        el('span', { class: 'swatch' }),
        primitive.label || primitive.id,
      );
      (chip.firstElementChild as HTMLElement).style.background = primitive.color;
      chip.addEventListener('click', () => select(primitive.id));
      objectList.append(chip);
    }
  };

  const select = (id: string | null) => {
    selectedId = id;
    builder.select(id);
    refreshList();
    refreshInspector();
    viewport.render(scene, camera);
  };

  const mutateSelected = (change: (p: Primitive) => void, rebuildGeometry = false) => {
    const primitive = selected();
    if (!primitive) return;
    change(primitive);
    const entry = builder.get(primitive.id);
    if (entry && rebuildGeometry) applyPrimitiveGeometry(entry.object as Mesh, primitive);
    else if (entry) {
      const mesh = entry.object as Mesh;
      mesh.position.set(...primitive.position);
      if (primitive.kind !== 'plane') mesh.rotation.set(0, primitive.rotationY, 0);
      mesh.visible = !primitive.hidden;
    }
    saveDraft();
    viewport.render(scene, camera);
  };

  const refreshInspector = () => {
    inspector.replaceChildren();
    const primitive = selected();
    if (!primitive) {
      inspector.append(
        el('p', {
          class: 'hint',
          text: 'Tap an object in the photo, or a chip below, to adjust or delete it.',
        }),
      );
      return;
    }

    const name = el('input', { type: 'text', value: primitive.label }) as HTMLInputElement;
    name.addEventListener('input', () => mutateSelected((p) => (p.label = name.value)));

    const kindSelect = el('select') as HTMLSelectElement;
    for (const kind of ['box', 'cylinder', 'plane']) {
      const option = el('option', { value: kind, text: kind });
      if (kind === primitive.kind) option.selected = true;
      kindSelect.append(option);
    }
    kindSelect.addEventListener('change', () =>
      mutateSelected((p) => (p.kind = kindSelect.value as Primitive['kind']), true),
    );

    const axisSlider = (
      label: string,
      get: (p: Primitive) => number,
      set: (p: Primitive, v: number) => void,
      min: number,
      max: number,
      step: number,
      rebuild = false,
      format?: (v: number) => string,
    ) =>
      slider({
        label,
        min,
        max,
        step,
        value: get(primitive),
        format,
        onInput: (value) => mutateSelected((p) => set(p, value), rebuild),
      });

    inspector.append(
      el(
        'div',
        { class: 'control-row' },
        el('span', { class: 'hint', text: 'Name' }),
        name,
        kindSelect,
      ),
      el(
        'div',
        { class: 'control-row' },
        axisSlider('Width (x)', (p) => p.size[0], (p, v) => (p.size[0] = v), 0.05, 12, 0.01, true,
          (v) => `${v.toFixed(2)} m`),
        axisSlider('Height (y)', (p) => p.size[1], (p, v) => (p.size[1] = v), 0.02, 6, 0.01, true,
          (v) => `${v.toFixed(2)} m`),
        axisSlider('Depth (z)', (p) => p.size[2], (p, v) => (p.size[2] = v), 0.05, 12, 0.01, true,
          (v) => `${v.toFixed(2)} m`),
      ),
      el(
        'div',
        { class: 'control-row' },
        axisSlider('Along x', (p) => p.position[0], (p, v) => (p.position[0] = v), -20, 20, 0.01,
          false, (v) => `${v.toFixed(2)} m`),
        axisSlider('Height off floor', (p) => p.position[1], (p, v) => (p.position[1] = v), -1, 6,
          0.01, false, (v) => `${v.toFixed(2)} m`),
        axisSlider('Along z', (p) => p.position[2], (p, v) => (p.position[2] = v), -20, 20, 0.01,
          false, (v) => `${v.toFixed(2)} m`),
        axisSlider('Turn', (p) => p.rotationY, (p, v) => (p.rotationY = v), -Math.PI, Math.PI,
          0.01, false, (v) => `${((v * 180) / Math.PI).toFixed(0)} deg`),
      ),
      el(
        'div',
        { class: 'control-row' },
        button(primitive.hidden ? 'Show' : 'Hide', () => {
          mutateSelected((p) => (p.hidden = !p.hidden));
          refreshList();
          refreshInspector();
        }),
        button('Stand on floor', () =>
          mutateSelected((p) => (p.position[1] = p.kind === 'plane' ? 0 : p.size[1] / 2)),
        ),
        el('span', { class: 'spacer' }),
        button('Delete', () => {
          primitives = primitives.filter((p) => p.id !== primitive.id);
          selectedId = null;
          saveDraft();
          rebuildScene();
          refreshList();
          refreshInspector();
        }, { class: 'btn-danger' }),
      ),
    );
  };

  // --- picking and placing ------------------------------------------------

  let addMode = false;
  const addButton = button('Add a box', () => {
    addMode = !addMode;
    addButton.textContent = addMode ? 'Tap the floor...' : 'Add a box';
    addButton.classList.toggle('btn-primary', addMode);
  });

  const onPointerDown = (event: PointerEvent) => {
    const [u, v] = frame.toImage(event.clientX, event.clientY);
    if (addMode) {
      const point = groundPointAt(solve, u, v);
      addMode = false;
      addButton.textContent = 'Add a box';
      addButton.classList.remove('btn-primary');
      if (!point) {
        store.notify('warn', 'That point is above the horizon, so it is not on the floor.');
        return;
      }
      const primitive: Primitive = {
        id: `user-${Date.now().toString(36)}`,
        kind: 'box',
        position: [point[0], 0.35, point[2]],
        size: [0.7, 0.7, 0.7],
        rotationY: 0,
        label: `box ${primitives.length + 1}`,
        color: '#8a93a5',
        source: 'manual',
        hidden: false,
      };
      primitives = [...primitives, primitive];
      saveDraft();
      rebuildScene();
      refreshList();
      select(primitive.id);
      return;
    }

    const ndc = new Vector2(
      (u / project.image.width) * 2 - 1,
      -((v / project.image.height) * 2 - 1),
    );
    const hit = viewport.pick(scene, ndc, camera);
    select(hit && hit.kind === 'primitive' ? hit.id : null);
  };

  viewport.canvas.addEventListener('pointerdown', onPointerDown);

  const unlisten = frame.onLayout((rect) => {
    viewport.setSize(rect.width, rect.height);
    viewport.render(scene, camera);
  });

  // --- building and confirming -------------------------------------------

  const buildButton = button('Build the proxy', () => void build(false), { class: 'btn' });
  const rebuildDepthButton = button('Recompute depth', () => void build(true), { class: 'btn' });
  const confirmButton = button('Confirm proxy', () => void confirm(), { class: 'btn-primary' });

  const applyProxyState = (state: ProxyState) => {
    primitives = clonePrimitives(state.primitives);
    selectedId = null;
    saveDraft();
    rebuildScene();
    refreshList();
    refreshInspector();
    const inlier = Math.round((state.fit.inlierFraction ?? 0) * 100);
    statusLine.innerHTML =
      `<strong>${state.depth.backend}</strong> depth, fitted to the floor with ` +
      `${inlier}% of the sampled floor pixels agreeing. ` +
      `${state.primitives.length - 1} objects found.`;
    if (state.depth.note) store.notify('warn', state.depth.note, 12000);
    if (inlier < 25) {
      store.notify(
        'warn',
        'Few floor pixels agreed with the ground plane. Check the solve, or adjust the ' +
          'primitives by hand.',
        12000,
      );
    }
  };

  const build = async (recomputeDepth: boolean) => {
    const handle = runJob<ProxyState>(
      () => api.buildProxy(project.id, { recomputeDepth }),
      ({ progress, message }) => store.updateBusy({ progress, message }),
    );
    store.setBusy({
      label: 'Building the proxy scene',
      progress: 0,
      message: '',
      cancel: handle.cancel,
    });
    try {
      applyProxyState(await handle.promise);
    } catch (error) {
      if ((error as Error).message !== 'Cancelled') store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  const confirm = async () => {
    store.setBusy({ label: 'Saving the proxy', progress: 0.5, message: '' });
    try {
      const updated = await api.confirmProxy(project.id, primitives);
      store.applyProject(updated);
      store.clearDraft('proxy');
      if (updated.cleared?.length) {
        store.notify('warn', `The proxy changed, so the ${updated.cleared.join(' and ')} were reset.`);
      }
      store.goTo('bodies');
    } catch (error) {
      store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  controls.append(
    statusLine,
    objectList,
    inspector,
    el(
      'div',
      { class: 'control-row' },
      slider({
        label: 'Overlay',
        min: 0.15,
        max: 1,
        step: 0.01,
        value: overlayOpacity,
        format: (v) => `${Math.round(v * 100)}%`,
        onInput: (value) => {
          overlayOpacity = value;
          viewport.canvas.style.opacity = String(value);
        },
      }),
      addButton,
      buildButton,
      rebuildDepthButton,
      el('span', { class: 'spacer' }),
      confirmButton,
    ),
  );

  if (project.proxy) {
    applyProxyState({ ...project.proxy, primitives });
  } else {
    statusLine.textContent =
      'Run the depth pass to place primitive stand-ins for the furniture.';
    rebuildScene();
    refreshList();
    refreshInspector();
    void build(false);
  }

  return () => {
    unlisten();
    viewport.canvas.removeEventListener('pointerdown', onPointerDown);
    viewport.dispose();
    builder.dispose();
    frame.dispose();
  };
}
