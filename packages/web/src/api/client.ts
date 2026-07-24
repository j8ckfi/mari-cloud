// HTTP client for the control plane. Thin wrapper over `fetch` returning typed
// responses; every call targets same-origin `/api/*` (Vite proxies it to the
// control-plane dev server, and in production the app is served behind the same
// edge). Reads never wake a computer; the only wake trigger is a file WRITE
// (spec 8.4), which the server performs — the client just PUTs.

import type {
  ComputerDetail,
  DirListing,
  FleetResponse,
  LayoutResponse,
  StartRunResponse,
} from './types';
import type { SerializedLayout } from '../wm/serialize';

/** Base for all control-plane HTTP endpoints. Overridable for tests. */
export const API_BASE = '/api';

/** Thrown for a non-2xx response. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status, url);
  return (await res.json()) as T;
}

/** Fleet home data (spec 8.2). */
export function fetchFleet(signal?: AbortSignal): Promise<FleetResponse> {
  return getJson<FleetResponse>('/fleet', signal);
}

/** One computer's detail, including live runs. */
export function fetchComputer(id: string, signal?: AbortSignal): Promise<ComputerDetail> {
  return getJson<ComputerDetail>(`/computers/${encodeURIComponent(id)}`, signal);
}

/** Directory listing from the manifest head (COLD-safe, spec 8.4). */
export function fetchDir(id: string, path: string, signal?: AbortSignal): Promise<DirListing> {
  const q = new URLSearchParams({ path });
  return getJson<DirListing>(`/computers/${encodeURIComponent(id)}/files?${q}`, signal);
}

/** Read a file's bytes from the manifest head (COLD-safe). */
export async function fetchFile(id: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const q = new URLSearchParams({ path });
  const url = `${API_BASE}/computers/${encodeURIComponent(id)}/file?${q}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new ApiError(`GET file ${path} → ${res.status}`, res.status, url);
  return new Uint8Array(await res.arrayBuffer());
}

/** Read a file as UTF-8 text (for the editor). */
export async function fetchFileText(id: string, path: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder().decode(await fetchFile(id, path, signal));
}

/**
 * Write a file. Per spec 8.4 this WAKES a computer that is not AWAKE; the wake
 * happens server-side and the interface does not block on it.
 */
export async function writeFile(id: string, path: string, contents: string | Uint8Array): Promise<void> {
  const q = new URLSearchParams({ path });
  const url = `${API_BASE}/computers/${encodeURIComponent(id)}/file?${q}`;
  const body = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  const res = await fetch(url, { method: 'PUT', body: body as BodyInit });
  if (!res.ok) throw new ApiError(`PUT file ${path} → ${res.status}`, res.status, url);
}

/** Load the saved pane layout for a computer (spec 8.6). */
export function fetchLayout(id: string, signal?: AbortSignal): Promise<LayoutResponse> {
  return getJson<LayoutResponse>(`/computers/${encodeURIComponent(id)}/layout`, signal);
}

/** Persist a computer's pane layout to the DO. */
export async function saveLayout(id: string, layout: SerializedLayout): Promise<void> {
  const url = `${API_BASE}/computers/${encodeURIComponent(id)}/layout`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(layout),
  });
  if (!res.ok) throw new ApiError(`PUT layout → ${res.status}`, res.status, url);
}

/** Start a run from a brief document (spec 8.5). */
export async function startRun(
  id: string,
  brief: { path: string; argv?: string[]; cwd?: string },
): Promise<StartRunResponse> {
  const url = `${API_BASE}/computers/${encodeURIComponent(id)}/runs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(brief),
  });
  if (!res.ok) throw new ApiError(`POST run → ${res.status}`, res.status, url);
  return (await res.json()) as StartRunResponse;
}
