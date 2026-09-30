/** Step 1: take in the photo. */

import { api } from '../api';
import { store } from '../store';
import { button, el } from '../ui/dom';

const ACCEPT = 'image/*';

export function renderUpload(container: HTMLElement): () => void {
  const input = el('input', { type: 'file', accept: ACCEPT, hidden: true }) as HTMLInputElement;

  const dropzone = el(
    'div',
    { class: 'dropzone', role: 'button', tabindex: '0' },
    el('h2', { text: 'Drop a photo here' }),
    el('p', {
      class: 'hint',
      text: 'Or tap to choose one. Interiors and streets with visible straight edges solve best.',
    }),
    button('Choose a photo', () => input.click(), { class: 'btn-primary' }),
    input,
  );

  const existing = store.get().project;
  const controls = el(
    'div',
    { class: 'controls' },
    el('p', {
      class: 'hint',
      html:
        'The photo is the source for every later step: the perspective solve reads its ' +
        'straight edges, the depth pass reads its content, and step 6 uses it as the ' +
        'image-to-image source so the new angle keeps the same light and look.',
    }),
    existing
      ? el(
          'div',
          { class: 'control-row' },
          el('span', { class: 'hint', text: `Current photo: ${existing.image.filename}` }),
          el('span', { class: 'spacer' }),
          button('Keep working on it', () => store.goTo('solve'), { class: 'btn-primary' }),
        )
      : null,
  );

  container.append(el('div', { class: 'step-root' }, dropzone, controls));

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      store.notify('error', `${file.name} is not an image.`);
      return;
    }
    store.setBusy({ label: 'Uploading', progress: 0.2, message: file.name });
    try {
      const project = await api.createProject(file);
      store.setProject(project);
      store.setBusy(null);
      store.notify('info', `Loaded ${project.image.width} x ${project.image.height} photo.`);
      store.goTo('solve');
    } catch (error) {
      store.setBusy(null);
      store.notify('error', error instanceof Error ? error.message : String(error));
    }
  };

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void upload(file);
  });

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') input.click();
  });

  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onDragOver = (event: DragEvent) => {
    stop(event);
    dropzone.classList.add('over');
  };
  const onDragLeave = (event: DragEvent) => {
    stop(event);
    dropzone.classList.remove('over');
  };
  const onDrop = (event: DragEvent) => {
    stop(event);
    dropzone.classList.remove('over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void upload(file);
  };

  dropzone.addEventListener('dragover', onDragOver);
  dropzone.addEventListener('dragleave', onDragLeave);
  dropzone.addEventListener('drop', onDrop);
  // Dropping anywhere on the page should work, not just on the dashed box.
  window.addEventListener('dragover', stop);
  window.addEventListener('drop', onDrop);

  return () => {
    window.removeEventListener('dragover', stop);
    window.removeEventListener('drop', onDrop);
  };
}
