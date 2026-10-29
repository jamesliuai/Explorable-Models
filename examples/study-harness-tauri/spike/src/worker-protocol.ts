// Messages exchanged between the page and the probe module worker.

export interface WorkerProbeRequest {
  kind: 'probe';
  requestId: string;
  /** Absolute same-origin URL of the bundled data resource, resolved by the page. */
  dataUrl: string;
}

export interface WorkerCheck {
  ok: boolean;
  detail: string;
}

export interface WorkerProbeReply {
  kind: 'probe-result';
  requestId: string;
  workerLocation: string;
  importMetaUrl: string;
  isSecureContext: boolean;
  lazyImport: WorkerCheck & { moduleUrl: string; value: number };
  digest: WorkerCheck & { hex: string };
  randomUUID: WorkerCheck & { sample: string };
  evalBlocked: WorkerCheck & { blocked: boolean };
  dataFetch: WorkerCheck & { samples: number };
  offscreen2d: WorkerCheck & { pngBytes: number };
  offscreenWebgl2: WorkerCheck & { available: boolean };
}

export interface WorkerErrorReply {
  kind: 'probe-error';
  requestId: string;
  message: string;
}
