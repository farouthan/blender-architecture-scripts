/** Small DOM helpers.  No framework: the app is a handful of canvases. */

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data-') || key === 'role') node.setAttribute(key, String(value));
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  options: { class?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: options.class ?? 'btn',
    type: 'button',
    title: options.title,
    disabled: options.disabled,
  });
  node.textContent = label;
  node.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}

export function slider(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (value: number) => void;
}): HTMLElement {
  const format = options.format ?? ((v: number) => v.toFixed(2));
  const readout = el('span', { class: 'slider-value', text: format(options.value) });
  const input = el('input', {
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = format(value);
    options.onInput(value);
  });
  return el(
    'label',
    { class: 'slider' },
    el('span', { class: 'slider-label' }, options.label, readout),
    input,
  );
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/** Clamp with a readable name, used all over the interaction code. */
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Format seconds-ish durations for the progress readout. */
export function formatCount(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
