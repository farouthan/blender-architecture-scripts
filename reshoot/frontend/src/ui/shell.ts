/**
 * The chrome around every step: the title, the step chips, the back and
 * "new image" actions, a non-blocking progress strip, and toast notices.
 *
 * The shell owns nothing about a step's content; steps mount into `#stage`.
 */

import { STEP_ORDER, STEP_SUBTITLES, STEP_TITLES, store } from '../store';
import type { StepId } from '../types';
import type { AppState } from '../store';
import { button, clear, el } from './dom';

export interface Shell {
  root: HTMLElement;
  content: HTMLElement;
  onNewImage: (handler: () => void) => void;
}

export function createShell(): Shell {
  const title = el('h1', { text: 'Re-shoot' });
  const subtitle = el('p', { text: STEP_SUBTITLES.upload });

  const backButton = button('Back', () => store.back(), { class: 'btn-ghost' });
  let newImageHandler: () => void = () => undefined;
  const newImageButton = button('New image', () => newImageHandler(), {
    class: 'btn-ghost',
    title: 'Start over from a new photo',
  });

  const stepper = el('nav', { class: 'stepper', role: 'tablist' });
  const progressStrip = el('div', { class: 'progress-strip', hidden: true });
  const progressFill = el('div');
  const progressBar = el('div', { class: 'progress-bar', hidden: true }, progressFill);

  const header = el(
    'header',
    { class: 'app-header' },
    el(
      'div',
      { class: 'header-row' },
      backButton,
      el('div', { class: 'header-title' }, title, subtitle),
      newImageButton,
    ),
    stepper,
    progressBar,
    progressStrip,
  );

  const content = el('main', { class: 'step-root', id: 'stage' });
  const notices = el('div', { class: 'notices' });
  const root = el('div', { class: 'app-shell' }, header, content, notices);

  let renderedStep: StepId | null = null;

  const renderStepper = (state: AppState) => {
    clear(stepper);
    STEP_ORDER.forEach((step, index) => {
      const blocked = store.blockedReason(step);
      const isCurrent = state.step === step;
      const isDone = !blocked && STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(state.step);
      const chip = el(
        'button',
        {
          class: 'step-chip',
          type: 'button',
          role: 'tab',
          title: blocked ?? STEP_TITLES[step],
          'data-state': isCurrent ? 'current' : blocked ? 'blocked' : isDone ? 'done' : 'ready',
        },
        el('span', { class: 'idx', text: String(index + 1) }),
        STEP_TITLES[step],
      );
      chip.addEventListener('click', () => store.goTo(step));
      stepper.append(chip);
    });
  };

  store.subscribe((state) => {
    if (state.step !== renderedStep) {
      renderedStep = state.step;
      const index = STEP_ORDER.indexOf(state.step);
      title.textContent = `Step ${index + 1} of ${STEP_ORDER.length} - ${
        STEP_TITLES[state.step]
      }`;
      subtitle.textContent = STEP_SUBTITLES[state.step];
    }
    backButton.disabled = !store.canGoBack();
    newImageButton.disabled = state.project === null && state.step === 'upload';
    renderStepper(state);

    const busy = state.busy;
    progressBar.hidden = !busy;
    progressStrip.hidden = !busy;
    if (busy) {
      progressFill.style.width = `${Math.round(busy.progress * 100)}%`;
      clear(progressStrip);
      progressStrip.append(
        el('span', { class: 'spinner' }),
        el('span', { text: `${busy.label}${busy.message ? ` - ${busy.message}` : ''}` }),
        el('span', { class: 'spacer' }),
        busy.cancel
          ? button('Cancel', () => busy.cancel?.(), { class: 'btn-ghost' })
          : el('span', { text: `${Math.round(busy.progress * 100)}%` }),
      );
    }

    clear(notices);
    for (const notice of state.notices) {
      const node = el('div', {
        class: 'notice',
        'data-kind': notice.kind,
        text: notice.text,
      });
      node.addEventListener('click', () => store.dismiss(notice.id));
      notices.append(node);
    }
  });

  return {
    root,
    content,
    onNewImage(handler) {
      newImageHandler = handler;
    },
  };
}

/** Standard two-part step layout: a stage that fills, controls that dock. */
export function stepLayout(): {
  root: HTMLElement;
  stage: HTMLElement;
  controls: HTMLElement;
} {
  const stage = el('div', { class: 'stage' });
  const controls = el('div', { class: 'controls' });
  return { root: el('div', { class: 'step-root' }, stage, controls), stage, controls };
}
