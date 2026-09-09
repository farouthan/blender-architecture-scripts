/**
 * A virtual thumbstick.
 *
 * Two of these drive step 5 -- one to move, one to look -- so the new angle can
 * be found without physically walking anywhere.  Values are read every frame
 * rather than pushed as events, which keeps the movement smooth and frame-rate
 * independent.
 */

export interface JoypadOptions {
  side: 'left' | 'right';
  caption: string;
  /** Snap back to centre on release.  Both sticks do; the option is here for clarity. */
  autoCentre?: boolean;
}

export class Joypad {
  readonly element: HTMLElement;
  private knob: HTMLElement;
  private pointerId: number | null = null;
  private value: [number, number] = [0, 0];
  private radius = 44;

  constructor(options: JoypadOptions) {
    this.element = document.createElement('div');
    this.element.className = `joypad ${options.side}`;

    this.knob = document.createElement('div');
    this.knob.className = 'knob';

    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = options.caption;

    this.element.append(this.knob, caption);

    this.element.addEventListener('pointerdown', this.onDown);
    this.element.addEventListener('pointermove', this.onMove);
    this.element.addEventListener('pointerup', this.onUp);
    this.element.addEventListener('pointercancel', this.onUp);
  }

  /** Current deflection, x right and y up, each in [-1, 1]. */
  read(): [number, number] {
    return this.value;
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  private onDown = (event: PointerEvent) => {
    this.pointerId = event.pointerId;
    this.element.setPointerCapture(event.pointerId);
    this.radius = this.element.clientWidth / 2 - 12;
    this.update(event);
    event.preventDefault();
  };

  private onMove = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.update(event);
    event.preventDefault();
  };

  private onUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    this.value = [0, 0];
    this.knob.style.transform = '';
  };

  private update(event: PointerEvent): void {
    const box = this.element.getBoundingClientRect();
    let dx = event.clientX - (box.left + box.width / 2);
    let dy = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > this.radius) {
      dx = (dx / distance) * this.radius;
      dy = (dy / distance) * this.radius;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Screen y grows downwards; a stick pushed forward should read positive.
    this.value = [dx / this.radius, -dy / this.radius];
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onDown);
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerup', this.onUp);
    this.element.removeEventListener('pointercancel', this.onUp);
    this.element.remove();
  }
}
