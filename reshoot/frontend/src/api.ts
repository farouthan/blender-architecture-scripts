/** Thin wrapper over the Python API, plus job polling. */

import type {
  BodiesState,
  Body as BodyRecord,
  ControlPoints,
  GenerationSettings,
  Health,
  Job,
  Primitive,
  Project,
  ProxyState,
  Shot,
  ShotCamera,
  StepId,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(
      'Could not reach the re-shoot server. Is `python run.py` still running?',
      0,
    );
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      /* the body was not JSON; the status line will have to do */
    }
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const put = (payload: unknown): RequestInit => ({ ...json(payload), method: 'PUT' });

export interface JobHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export interface JobProgress {
  progress: number;
  message: string;
}

/**
 * Start a server job and resolve when it finishes.
 *
 * Polling rather than streaming keeps this robust behind proxies and makes
 * cancellation trivial; the interval is short enough to feel live.
 */
export function runJob<T>(
  start: () => Promise<Job<T>>,
  onProgress?: (p: JobProgress) => void,
  intervalMs = 350,
): JobHandle<T> {
  let cancelled = false;
  let jobId: string | null = null;

  const promise = (async () => {
    const job = await start();
    jobId = job.id;
    if (cancelled) {
      await cancelJob(job.id);
      throw new ApiError('Cancelled', 0);
    }
    onProgress?.({ progress: job.progress, message: job.message || 'Queued' });

    for (;;) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const state = await request<Job<T>>(`/api/jobs/${job.id}`);
      onProgress?.({ progress: state.progress, message: state.message });
      if (state.status === 'done') return state.result as T;
      if (state.status === 'error') throw new ApiError(state.error ?? 'Job failed', 500);
      if (state.status === 'cancelled') throw new ApiError('Cancelled', 0);
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (jobId) void cancelJob(jobId);
    },
  };
}

const cancelJob = (id: string) => request(`/api/jobs/${id}/cancel`, { method: 'POST' });

export const api = {
  health: () => request<Health>('/api/health'),

  listProjects: () => request<{ projects: unknown[] }>('/api/projects'),

  createProject(file: File): Promise<Project> {
    const form = new FormData();
    form.append('file', file);
    return request<Project>('/api/projects', { method: 'POST', body: form });
  },

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  deleteProject: (id: string) => request(`/api/projects/${id}`, { method: 'DELETE' }),

  assetUrl: (id: string, name: string) => `/api/projects/${id}/asset/${name}`,

  imageUrl: (project: Project) => `/api/projects/${project.id}/asset/${project.image.file}`,

  autoSolve: (id: string) =>
    request<Job<ControlPoints>>(`/api/projects/${id}/solve/auto`, { method: 'POST' }),

  confirmSolve: (id: string, controlPoints: ControlPoints, cameraHeight: number) =>
    request<Project>(`/api/projects/${id}/solve`, put({ controlPoints, cameraHeight })),

  buildProxy: (id: string, options: { recomputeDepth?: boolean; voxel?: number } = {}) =>
    request<Job<ProxyState>>(`/api/projects/${id}/proxy`, json(options)),

  confirmProxy: (id: string, primitives: Primitive[]) =>
    request<Project>(`/api/projects/${id}/proxy`, put({ primitives })),

  detectBodies: (id: string) =>
    request<Job<BodiesState>>(`/api/projects/${id}/bodies`, { method: 'POST' }),

  bodyFromBox: (id: string, bbox: [number, number, number, number], bodyId?: string) =>
    request<{ body: BodyRecord; warning: string | null }>(
      `/api/projects/${id}/bodies/from-box`,
      json({ bbox, id: bodyId }),
    ),

  confirmBodies: (id: string, bodies: BodyRecord[]) =>
    request<Project>(`/api/projects/${id}/bodies`, put({ bodies })),

  setStep: (id: string, step: StepId) =>
    request<Project>(`/api/projects/${id}/step`, put({ step })),

  createShot(
    id: string,
    camera: ShotCamera,
    settings: GenerationSettings,
    renders: { depth: Blob; normal: Blob; preview?: Blob },
  ): Promise<Job<Shot>> {
    const form = new FormData();
    form.append('camera', JSON.stringify(camera));
    form.append('settings', JSON.stringify(settings));
    form.append('depth', renders.depth, 'depth.png');
    form.append('normal', renders.normal, 'normal.png');
    if (renders.preview) form.append('preview', renders.preview, 'preview.png');
    return request<Job<Shot>>(`/api/projects/${id}/shots`, { method: 'POST', body: form });
  },
};
