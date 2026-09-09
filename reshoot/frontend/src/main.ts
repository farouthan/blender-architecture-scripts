/**
 * Entry point: mount the shell, restore the last project, and swap step views.
 *
 * Each step renders into a fresh container and returns its own teardown, so
 * moving between steps never leaks a WebGL context, a resize observer or a
 * pointer listener.
 */

import './styles.css';

import { ApiError, api } from './api';
import { STEP_ORDER, Store, store } from './store';
import { renderBodies } from './steps/bodies';
import { renderNavigate } from './steps/navigate';
import { renderProxy } from './steps/proxy';
import { renderRender } from './steps/render';
import { renderSolve } from './steps/solve';
import { renderUpload } from './steps/upload';
import type { StepId } from './types';
import { clear, el } from './ui/dom';
import { createShell } from './ui/shell';

type StepRenderer = (container: HTMLElement) => () => void;

const RENDERERS: Record<StepId, StepRenderer> = {
  upload: renderUpload,
  solve: renderSolve,
  proxy: renderProxy,
  bodies: renderBodies,
  navigate: renderNavigate,
  render: renderRender,
};

function mount(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app is missing from the page');

  const shell = createShell();
  app.append(shell.root);

  let currentStep: StepId | null = null;
  let currentProjectId: string | null = null;
  let teardown: (() => void) | null = null;

  const renderStep = (step: StepId, projectId: string | null) => {
    teardown?.();
    teardown = null;
    clear(shell.content);
    currentStep = step;
    currentProjectId = projectId;
    try {
      teardown = RENDERERS[step](shell.content);
    } catch (error) {
      console.error(error);
      store.notify('error', `The ${step} step failed to open: ${(error as Error).message}`);
      shell.content.append(
        el('div', { class: 'controls' }, el('p', { class: 'hint', text: String(error) })),
      );
    }
  };

  store.subscribe((state) => {
    const projectId = state.project?.id ?? null;
    if (state.step !== currentStep || projectId !== currentProjectId) {
      renderStep(state.step, projectId);
    }
  });

  shell.onNewImage(() => {
    const state = store.get();
    if (state.busy) {
      store.notify('warn', 'Something is still running. Cancel it first.');
      return;
    }
    if (
      state.project &&
      !window.confirm(
        'Start over with a new photo? The current solve, proxy and people stay saved on ' +
          'the server, but this session will open a fresh project.',
      )
    ) {
      return;
    }
    store.setProject(null);
    store.goTo('upload');
  });

  void bootstrap();
}

async function bootstrap(): Promise<void> {
  try {
    store.patch({ health: await api.health() });
  } catch {
    store.notify(
      'error',
      'The re-shoot server is not responding. Start it with `python run.py` in ' +
        'reshoot/backend.',
      0,
    );
    return;
  }

  const lastId = Store.lastProjectId();
  if (!lastId) return;
  try {
    const project = await api.getProject(lastId);
    store.setProject(project);
    // Reopen at the furthest step the saved work supports, not blindly at the
    // stored pointer, so a half-finished project cannot land on a blocked step.
    const stored = project.step;
    const furthest = store.furthestStep();
    const target =
      STEP_ORDER.indexOf(stored) <= STEP_ORDER.indexOf(furthest) ? stored : furthest;
    store.goTo(target);
    store.notify('info', `Reopened ${project.image.filename}.`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      store.notify('warn', `Could not reopen the last project: ${(error as Error).message}`);
    }
  }
}

mount();
