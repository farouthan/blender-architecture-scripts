/**
 * A letterboxed photo with an aligned overlay surface.
 *
 * Every step after the upload draws on top of the photo, and the drawing has to
 * line up with it pixel for pixel -- the whole point of the solve is that the
 * virtual camera reproduces the real one.  So the image and the overlay canvas
 * share one rectangle, computed here and kept in sync with the container size.
 */

export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** CSS pixels per image pixel. */
  scale: number;
}

export class PhotoFrame {
  readonly root: HTMLElement;
  readonly image: HTMLImageElement;
  readonly overlay: HTMLCanvasElement;

  private rect: FrameRect = { left: 0, top: 0, width: 0, height: 0, scale: 1 };
  private observer: ResizeObserver;
  private listeners = new Set<(rect: FrameRect) => void>();
  private extras: HTMLElement[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly imageWidth: number,
    private readonly imageHeight: number,
    src: string,
  ) {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
    });

    this.image = document.createElement('img');
    this.image.src = src;
    this.image.alt = 'The photo being re-shot';
    this.image.draggable = false;
    Object.assign(this.image.style, {
      position: 'absolute',
      userSelect: 'none',
      pointerEvents: 'none',
    });

    this.overlay = document.createElement('canvas');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      touchAction: 'none',
    });

    this.root.append(this.image, this.overlay);
    container.append(this.root);

    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(container);
    this.layout();
  }

  /** Position another element (a WebGL canvas, say) in the same rectangle. */
  addLayer(node: HTMLElement): HTMLElement {
    Object.assign(node.style, { position: 'absolute' });
    this.extras.push(node);
    this.root.append(node);
    this.layout();
    return node;
  }

  onLayout(listener: (rect: FrameRect) => void): () => void {
    this.listeners.add(listener);
    listener(this.rect);
    return () => this.listeners.delete(listener);
  }

  getRect(): FrameRect {
    return this.rect;
  }

  /** Client coordinates -> image pixel coordinates. */
  toImage(clientX: number, clientY: number): [number, number] {
    const box = this.root.getBoundingClientRect();
    return [
      (clientX - box.left - this.rect.left) / this.rect.scale,
      (clientY - box.top - this.rect.top) / this.rect.scale,
    ];
  }

  /** Image pixel coordinates -> coordinates within the overlay canvas (CSS px). */
  toOverlay(u: number, v: number): [number, number] {
    return [u * this.rect.scale, v * this.rect.scale];
  }

  /** A 2D context scaled so drawing can be done in image pixel coordinates. */
  overlayContext(): CanvasRenderingContext2D | null {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr * this.rect.scale, 0, 0, dpr * this.rect.scale, 0, 0);
    ctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
    return ctx;
  }

  private layout(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(width / this.imageWidth, height / this.imageHeight);
    const w = this.imageWidth * scale;
    const h = this.imageHeight * scale;
    const left = (width - w) / 2;
    const top = (height - h) / 2;
    this.rect = { left, top, width: w, height: h, scale };

    for (const node of [this.image, this.overlay, ...this.extras]) {
      Object.assign(node.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = Math.max(1, Math.round(w * dpr));
    this.overlay.height = Math.max(1, Math.round(h * dpr));

    for (const listener of this.listeners) listener(this.rect);
  }

  dispose(): void {
    this.observer.disconnect();
    this.listeners.clear();
    this.root.remove();
  }
}
