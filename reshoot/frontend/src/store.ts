/**
 * Application state and step navigation.
 *
 * Two kinds of state live here.  *Confirmed* state is whatever the server has
 * saved -- the solve, the proxy, the bodies -- and is the reason going back is
 * free.  *Draft* state is the user's in-flight corrections for a step they have
 * not confirmed yet; it is mirrored into localStorage so a reload, or a bounce
 * out to another step and back, does not lose a half-finished adjustment.
 */

import { api } from './api';
import type {
  Body,
  ControlPoints,
  GenerationSettings,
  Health,
  Primitive,
  Project,
  ShotCamera,
  StepId,
} from './types';

export const STEP_ORDER: StepId[] = [
  'upload',
  'solve',
  'proxy',
  'bodies',
  'navigate',
  'render',
];

export const STEP_TITLES: Record<StepId, string> = {
  upload: 'Photo',
  solve: 'Perspective',
  proxy: 'Proxy scene',
  bodies: 'People',
  navigate: 'New angle',
  render: 'Re-shoot',
};

export const STEP_SUBTITLES: Record<StepId, string> = {
  upload: 'Drop in the photo you want to re-shoot.',
  solve: 'Line up the axes until the ground grid sits right.',
  proxy: 'Check the primitive stand-ins for the furniture.',
  bodies: 'Place everyone in the room.',
  navigate: 'Move the camera and lock the angle you want.',
  render: 'Generate the new view.',
};

export interface Drafts {
  solve?: { controlPoints: ControlPoints; cameraHeight: number };
  proxy?: { primitives: Primitive[] };
  bodies?: { bodies: Body[] };
  navigate?: { camera: ShotCamera };
  render?: GenerationSettings;
}

export interface Busy {
  label: string;
  progress: number;
  message: string;
  cancel?: () => void;
}

export interface Notice {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  health: Health | null;
  project: Project | null;
  step: StepId;
  drafts: Drafts;
  busy: Busy | null;
  notices: Notice[];
}

type Listener = (state: AppState) => void;

const LAST_PROJECT_KEY = 'reshoot:lastProject';
const draftKey = (projectId: string) => `reshoot:drafts:${projectId}`;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing or a full quota; drafts are a convenience, not a contract */
  }
}

export class Store {
  private state: AppState = {
    health: null,
    project: null,
    step: 'upload',
    drafts: {},
    busy: null,
    notices: [],
  };

  private listeners = new Set<Listener>();
  private noticeSeq = 0;

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  // --- project ------------------------------------------------------------

  setProject(project: Project | null, options: { keepDrafts?: boolean } = {}): void {
    const changed = project?.id !== this.state.project?.id;
    this.state.project = project;
    if (project) {
      writeJson(LAST_PROJECT_KEY, project.id);
      if (changed && !options.keepDrafts) {
        this.state.drafts = readJson<Drafts>(draftKey(project.id)) ?? {};
      }
    } else {
      try {
        localStorage.removeItem(LAST_PROJECT_KEY);
      } catch {
        /* ignore */
      }
      this.state.drafts = {};
    }
    this.emit();
  }

  static lastProjectId(): string | null {
    return readJson<string>(LAST_PROJECT_KEY);
  }

  /**
   * Fold a fresh project record in, dropping drafts whose step the server just
   * invalidated.  Confirming a new camera solve, for instance, clears the proxy
   * server-side, so the stale proxy draft must go with it.
   */
  applyProject(project: Project): void {
    for (const key of project.cleared ?? []) {
      if (key === 'proxy') delete this.state.drafts.proxy;
      if (key === 'bodies') delete this.state.drafts.bodies;
      if (key === 'shots') delete this.state.drafts.render;
    }
    this.state.project = project;
    this.persistDrafts();
    this.emit();
  }

  // --- drafts -------------------------------------------------------------

  setDraft<K extends keyof Drafts>(key: K, value: Drafts[K]): void {
    this.state.drafts = { ...this.state.drafts, [key]: value };
    this.persistDrafts();
    this.emit();
  }

  /** Update a draft without re-rendering; for values that change every frame. */
  setDraftQuietly<K extends keyof Drafts>(key: K, value: Drafts[K]): void {
    this.state.drafts = { ...this.state.drafts, [key]: value };
    this.persistDrafts();
  }

  clearDraft(key: keyof Drafts): void {
    delete this.state.drafts[key];
    this.persistDrafts();
    this.emit();
  }

  private persistDrafts(): void {
    if (this.state.project) writeJson(draftKey(this.state.project.id), this.state.drafts);
  }

  // --- navigation ---------------------------------------------------------

  /** Why a step cannot be opened yet, or null when it can. */
  blockedReason(step: StepId): string | null {
    const project = this.state.project;
    if (step === 'upload') return null;
    if (!project) return 'Add a photo first.';
    switch (step) {
      case 'solve':
        return null;
      case 'proxy':
        return project.solve?.confirmed ? null : 'Confirm the perspective solve first.';
      case 'bodies':
        return project.proxy?.confirmed ? null : 'Confirm the proxy scene first.';
      case 'navigate':
        return project.bodies?.confirmed ? null : 'Confirm the people first.';
      case 'render':
        return this.state.drafts.navigate || project.shots.length
          ? null
          : 'Lock a camera angle first.';
      default:
        return null;
    }
  }

  /** The furthest step the project has unlocked. */
  furthestStep(): StepId {
    let furthest: StepId = 'upload';
    for (const step of STEP_ORDER) {
      if (this.blockedReason(step)) break;
      furthest = step;
    }
    return furthest;
  }

  goTo(step: StepId): boolean {
    const reason = this.blockedReason(step);
    if (reason) {
      this.notify('warn', reason);
      return false;
    }
    this.state.step = step;
    this.emit();
    const project = this.state.project;
    if (project && step !== 'upload') {
      // Fire and forget: the stored pointer is only a convenience for the next
      // reload, so a failure here must not interrupt navigation.
      void api.setStep(project.id, step).catch(() => undefined);
    }
    return true;
  }

  back(): void {
    const index = STEP_ORDER.indexOf(this.state.step);
    if (index <= 0) return;
    this.state.step = STEP_ORDER[index - 1];
    this.emit();
  }

  canGoBack(): boolean {
    return STEP_ORDER.indexOf(this.state.step) > 0;
  }

  // --- progress and notices ----------------------------------------------

  setBusy(busy: Busy | null): void {
    this.state.busy = busy;
    this.emit();
  }

  updateBusy(partial: Partial<Busy>): void {
    if (!this.state.busy) return;
    this.state.busy = { ...this.state.busy, ...partial };
    this.emit();
  }

  notify(kind: Notice['kind'], text: string, ttlMs = 6000): void {
    const notice: Notice = { id: (this.noticeSeq += 1), kind, text };
    this.state.notices = [...this.state.notices, notice];
    this.emit();
    if (ttlMs > 0) setTimeout(() => this.dismiss(notice.id), ttlMs);
  }

  dismiss(id: number): void {
    this.state.notices = this.state.notices.filter((n) => n.id !== id);
    this.emit();
  }
}

export const store = new Store();
