/**
 * Step 6: render the locked angle and generate the new view.
 *
 * The proxy scene is rendered twice offscreen -- depth and normals -- and both
 * go up as the control signal.  The original photograph is the image-to-image
 * source, so the generated frame keeps its light, its colour and its materials
 * while the geometry follows the new camera.  The photo projected onto the
 * proxy goes up too, and the server hands it back as the result when no
 * diffusion backend is installed.
 */

import { PerspectiveCamera, Quaternion, Scene } from 'three';
import { api, runJob } from '../api';
import { store } from '../store';
import type { GenerationSettings, Shot, ShotCamera } from '../types';
import { button, el, slider } from '../ui/dom';
import { stepLayout } from '../ui/shell';
import { NEAR, FAR } from '../three/cameraRig';
import { freeCameraFromSolve } from '../three/cameraRig';
import { canvasToPng, renderControlBuffers } from '../three/passes';
import { ProjectiveTexturer, loadPhotoTexture } from '../three/projective';
import { ProxySceneBuilder } from '../three/proxyScene';
import { Viewport, standardLights } from '../three/viewport';

const DEFAULT_SETTINGS: GenerationSettings = {
  prompt: '',
  negativePrompt: '',
  strength: 0.72,
  guidance: 7,
  steps: 30,
  seed: -1,
  depthWeight: 1,
  normalWeight: 0.6,
};

/** Generation resolution, rounded to the multiple of 8 that diffusers wants. */
function renderSize(aspect: number, longEdge = 768): [number, number] {
  const round8 = (v: number) => Math.max(8, Math.round(v / 8) * 8);
  return aspect >= 1
    ? [round8(longEdge), round8(longEdge / aspect)]
    : [round8(longEdge * aspect), round8(longEdge)];
}

export function renderRender(container: HTMLElement): () => void {
  const project = store.get().project;
  const shotCamera = store.get().drafts.navigate?.camera ?? project?.shots.at(-1)?.camera;
  if (!project?.solve?.camera || !shotCamera) {
    store.goTo('navigate');
    return () => undefined;
  }

  const solve = project.solve.camera;
  const { root, stage, controls } = stepLayout();
  container.append(root);

  const compare = el('div', { class: 'compare' });
  const resultImage = el('img', { alt: 'The re-shot frame' }) as HTMLImageElement;
  const placeholder = el('p', {
    class: 'hint',
    text: 'Render the locked angle to generate the new view.',
  });
  compare.append(placeholder);
  stage.append(compare);

  // An offscreen viewport: nothing here is shown live, it only produces buffers.
  const viewport = new Viewport();
  viewport.canvas.style.display = 'none';
  stage.append(viewport.canvas);

  const builder = new ProxySceneBuilder();
  const scene: Scene = builder.scene;
  scene.add(standardLights());
  builder.setPrimitives(project.proxy?.primitives ?? []);
  builder.setBodies(project.bodies?.bodies ?? []);

  const [width, height] = renderSize(solve.aspect);
  viewport.setSize(width, height);

  const camera = new PerspectiveCamera(shotCamera.fov, solve.aspect, NEAR, FAR);
  const applyShotCamera = (shot: ShotCamera) => {
    camera.position.set(...shot.position);
    camera.quaternion.copy(new Quaternion(...shot.quaternion));
    camera.fov = shot.fov;
    camera.aspect = solve.aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
  applyShotCamera(shotCamera);

  let settings: GenerationSettings = { ...DEFAULT_SETTINGS, ...(store.get().drafts.render ?? {}) };
  let lastShot: Shot | null = project.shots.at(-1) ?? null;

  const tiles = el('div', { class: 'result-grid' });
  const noteLine = el('p', { class: 'hint' });

  const tile = (caption: string, src: string) =>
    el(
      'figure',
      { class: 'result-tile' },
      el('img', { src, alt: caption, loading: 'lazy' }),
      el('figcaption', { text: caption }),
    );

  const showShot = (shot: Shot) => {
    lastShot = shot;
    resultImage.src = `${api.assetUrl(project.id, shot.result)}?t=${Date.now()}`;
    compare.replaceChildren(resultImage);
    noteLine.innerHTML =
      `Rendered by <strong>${shot.backend}</strong>` +
      (shot.seed !== null && shot.seed !== undefined ? ` with seed ${shot.seed}.` : '.') +
      (shot.note ? ` ${shot.note}` : '');
    tiles.replaceChildren(
      ...[
        tile('Depth control', api.assetUrl(project.id, shot.renders.depth)),
        tile('Normal control', api.assetUrl(project.id, shot.renders.normal)),
        shot.renders.preview
          ? tile('Photo projected on the proxy', api.assetUrl(project.id, shot.renders.preview))
          : null,
        tile('Original photo', api.imageUrl(project)),
      ].filter((node): node is HTMLElement => node !== null),
    );
  };

  /** Depth, normals and the projected preview from the locked camera. */
  const captureBuffers = async () => {
    const buffers = await renderControlBuffers(
      viewport.renderer,
      scene,
      camera,
      width,
      height,
    );

    let preview: Blob | undefined;
    try {
      const texture = await loadPhotoTexture(api.imageUrl(project));
      const projector = new ProjectiveTexturer(texture);
      projector.updateSourceDepth(viewport.renderer, scene, freeCameraFromSolve(solve));
      projector.render(viewport.renderer, scene, camera);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(viewport.canvas, 0, 0, width, height);
        preview = await canvasToPng(canvas);
      }
      projector.dispose();
      texture.dispose();
    } catch {
      // The projected preview is a nicety; the depth and normal control
      // renders are what the generator actually needs.
    }
    return { depth: buffers.depth, normal: buffers.normal, preview };
  };

  const generate = async () => {
    const handle = runJob<Shot>(async () => {
      store.updateBusy({ progress: 0.05, message: 'Rendering depth and normals' });
      const renders = await captureBuffers();
      store.updateBusy({ progress: 0.15, message: 'Uploading' });
      return api.createShot(project.id, currentCamera(), settings, renders);
    }, ({ progress, message }) => store.updateBusy({ progress, message }));

    store.setBusy({
      label: 'Re-shooting',
      progress: 0,
      message: 'Preparing',
      cancel: handle.cancel,
    });
    try {
      const shot = await handle.promise;
      showShot(shot);
      const refreshed = await api.getProject(project.id);
      store.applyProject(refreshed);
      if (shot.note) store.notify('warn', shot.note, 14000);
    } catch (error) {
      if ((error as Error).message !== 'Cancelled') store.notify('error', (error as Error).message);
    } finally {
      store.setBusy(null);
    }
  };

  const currentCamera = (): ShotCamera => ({
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [
      camera.quaternion.x,
      camera.quaternion.y,
      camera.quaternion.z,
      camera.quaternion.w,
    ],
    fov: camera.fov,
  });

  const saveSettings = () => store.setDraftQuietly('render', settings);

  const promptInput = el('textarea', {
    placeholder:
      'Optional. Leave blank to use the default: the same room, same people, same light, ' +
      'new angle.',
  }) as HTMLTextAreaElement;
  promptInput.value = settings.prompt;
  promptInput.addEventListener('input', () => {
    settings = { ...settings, prompt: promptInput.value };
    saveSettings();
  });

  const seedInput = el('input', { type: 'number', value: String(settings.seed) }) as HTMLInputElement;
  seedInput.addEventListener('input', () => {
    settings = { ...settings, seed: Number(seedInput.value) || -1 };
    saveSettings();
  });

  const numberSlider = (
    label: string,
    key: keyof GenerationSettings,
    min: number,
    max: number,
    step: number,
    format?: (v: number) => string,
  ) =>
    slider({
      label,
      min,
      max,
      step,
      value: settings[key] as number,
      format,
      onInput: (value) => {
        settings = { ...settings, [key]: value };
        saveSettings();
      },
    });

  const renderButton = button('Render this angle', () => void generate(), {
    class: 'btn-primary',
  });
  const rerenderButton = button('Re-render', () => void generate(), {
    title: 'Generate again from the same angle',
  });
  const reframeButton = button('Re-frame', () => store.goTo('navigate'), {
    title: 'Go back and pick a different angle; the scene stays built',
  });
  const downloadButton = button('Download', () => {
    if (!lastShot) return;
    const link = document.createElement('a');
    link.href = api.assetUrl(project.id, lastShot.result);
    link.download = `${project.id}-${lastShot.id}.png`;
    link.click();
  });

  controls.append(
    noteLine,
    tiles,
    el(
      'details',
      { class: 'card' },
      el('summary', { text: 'Generation settings' }),
      el('p', {
        class: 'hint',
        text:
          'The original photo is always the image-to-image source. Strength decides how far ' +
          'the generator is allowed to move away from it; the control weights decide how ' +
          'hard the new geometry is enforced.',
      }),
      promptInput,
      el(
        'div',
        { class: 'control-row' },
        numberSlider('Strength', 'strength', 0.2, 1, 0.01),
        numberSlider('Guidance', 'guidance', 1, 15, 0.1),
        numberSlider('Steps', 'steps', 8, 60, 1, (v) => v.toFixed(0)),
      ),
      el(
        'div',
        { class: 'control-row' },
        numberSlider('Depth control', 'depthWeight', 0, 2, 0.05),
        numberSlider('Normal control', 'normalWeight', 0, 2, 0.05),
        el('label', { class: 'slider' }, el('span', { class: 'slider-label' }, 'Seed'), seedInput),
      ),
    ),
    el(
      'div',
      { class: 'control-row' },
      renderButton,
      rerenderButton,
      reframeButton,
      downloadButton,
      el('span', { class: 'spacer' }),
    ),
  );

  const updateButtons = () => {
    rerenderButton.disabled = !lastShot;
    downloadButton.disabled = !lastShot;
    renderButton.textContent = lastShot ? 'Render again' : 'Render this angle';
  };

  if (lastShot && store.get().drafts.navigate === undefined) {
    showShot(lastShot);
  }
  updateButtons();
  const unsubscribe = store.subscribe(() => updateButtons());

  return () => {
    unsubscribe();
    viewport.dispose();
    builder.dispose();
  };
}
