// HTTP client for the control plane. Thin wrapper over `fetch` returning typed
// responses; every call targets same-origin `/api/*` (Vite proxies it to the
// control-plane dev server, and in production the app is served behind the same
// edge). Reads never wake a computer; the only wake trigger is a file WRITE
// (spec 8.4), which the server performs — the client just PUTs.

import type {
  ComputerDetail,
  ComputerCreated,
  ConfigResponse,
  DiffResponse,
  DirListing,
  FleetResponse,
  IncidentsResponse,
  LayoutResponse,
  LimitsResponse,
  PreviewResponse,
  ReviewResponse,
  RunListResponse,
  SecretNamesResponse,
  SnapshotResponse,
  StartRunRequest,
  StartRunResponse,
  StopRunResponse,
  UploadResponse,
  UsageResponse,
  WakeOutcome,
  WriteFileResponse,
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

// ---- session expiry -------------------------------------------------------
//
// Every route under `/api/*` (except Better Auth's own) is behind the session
// guard, so a 401 from ANY of them is the single authoritative signal that the
// session the app was using has stopped being valid. The auth gate subscribes
// here rather than polling `get-session`: a session can lapse at any moment
// (expiry, sign-out in another tab, a revoked session) and the interface must
// show the sign-in screen the first time the server says so, not one poll later.

const unauthorizedListeners = new Set<() => void>();

/** Subscribe to "the control plane answered 401". Returns a disposer. */
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

/** Pass a response through, announcing a 401 to the gate. */
function noteAuth<T extends { status: number }>(res: T): T {
  if (res.status === 401) {
    for (const fn of Array.from(unauthorizedListeners)) fn();
  }
  return res;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = noteAuth(await fetch(url, { signal, headers: { accept: 'application/json' } }));
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status, url);
  return (await res.json()) as T;
}

/** POST JSON (or nothing) and decode a JSON response. */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = noteAuth(
    await fetch(url, {
      method: 'POST',
      headers: body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  if (!res.ok) throw new ApiError(`POST ${path} → ${res.status}`, res.status, url);
  return (await res.json()) as T;
}

/** URL-safe computer segment. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

/** Fleet home data (spec 8.2). */
export function fetchFleet(signal?: AbortSignal): Promise<FleetResponse> {
  return getJson<FleetResponse>('/fleet', signal);
}

/**
 * Create a computer (the first-run action). It is created COLD — an identity
 * and a manifest head in the chunk store — so this is a fast write and NOT a
 * wake: nothing is materialized on a substrate until something runs.
 */
export function createComputer(name?: string): Promise<ComputerCreated> {
  return postJson<ComputerCreated>('/computers', name === undefined ? {} : { name });
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
  const res = noteAuth(await fetch(url, { signal }));
  if (!res.ok) throw new ApiError(`GET file ${path} → ${res.status}`, res.status, url);
  return new Uint8Array(await res.arrayBuffer());
}

/** Read a file as UTF-8 text (for the editor). */
export async function fetchFileText(id: string, path: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder().decode(await fetchFile(id, path, signal));
}

/**
 * Write a file. Per spec 8.4 this WAKES a computer that is not AWAKE; the wake
 * happens server-side and the interface does not block on it. The response
 * reports the resulting computer state so the caller can show the transition
 * (spec 8.3: the transition is shown, never waited on).
 */
export async function writeFile(
  id: string,
  path: string,
  contents: string | Uint8Array,
): Promise<WriteFileResponse> {
  const q = new URLSearchParams({ path });
  const url = `${API_BASE}/computers/${seg(id)}/file?${q}`;
  const body = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  const res = noteAuth(await fetch(url, { method: 'PUT', body: body as BodyInit }));
  if (!res.ok) throw new ApiError(`PUT file ${path} → ${res.status}`, res.status, url);
  return (await readJsonOr(res, { ok: true, path, state: 'waking' as const })) as WriteFileResponse;
}

/** Decode a JSON body, falling back when the server answered with no body. */
async function readJsonOr<T>(res: Response, fallback: T): Promise<T> {
  try {
    const text = await res.text();
    if (text.trim() === '') return fallback;
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Upload a file into the computer (files pane). Multipart, so a browser file
 * streams without a base64 round-trip. Same wake semantics as a write (8.4).
 * If the server has no upload route, this falls back to the plain file write —
 * the two are equivalent for a single file, and the UI must not lose the
 * user's upload over a route-shape disagreement.
 */
export async function uploadFile(id: string, path: string, file: Blob): Promise<UploadResponse> {
  const url = `${API_BASE}/computers/${seg(id)}/upload`;
  const form = new FormData();
  form.set('path', path);
  form.set('file', file);
  const res = noteAuth(await fetch(url, { method: 'POST', body: form }));
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const written = await writeFile(id, path, bytes);
    return { ok: written.ok, path: written.path, state: written.state };
  }
  if (!res.ok) throw new ApiError(`POST upload ${path} → ${res.status}`, res.status, url);
  return (await readJsonOr(res, { ok: true, path, state: 'waking' as const })) as UploadResponse;
}

/** Load the saved pane layout for a computer (spec 8.6). */
export function fetchLayout(id: string, signal?: AbortSignal): Promise<LayoutResponse> {
  return getJson<LayoutResponse>(`/computers/${encodeURIComponent(id)}/layout`, signal);
}

/** Persist a computer's pane layout to the DO. */
export async function saveLayout(id: string, layout: SerializedLayout): Promise<void> {
  const url = `${API_BASE}/computers/${encodeURIComponent(id)}/layout`;
  const res = noteAuth(
    await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(layout),
    }),
  );
  if (!res.ok) throw new ApiError(`PUT layout → ${res.status}`, res.status, url);
}

// ---- runs (spec 5) ----

/**
 * Start a run (spec 5.1: the SUPERVISOR owns the run — this request only asks
 * the control plane to start one; no network connection owns it afterwards).
 * `envNames` carries vault variable NAMES only; values never leave the vault
 * (spec 10.1, contracts §5.2).
 */
export function startRun(id: string, req: StartRunRequest): Promise<StartRunResponse> {
  const body: StartRunRequest = { argv: req.argv };
  if (req.cwd !== undefined) body.cwd = req.cwd;
  if (req.envNames !== undefined) body.envNames = req.envNames;
  return postJson<StartRunResponse>(`/computers/${seg(id)}/runs`, body);
}

/** Stop a run's process (contracts §5.2 `stop_run`). */
export function stopRun(id: string, runId: string): Promise<StopRunResponse> {
  return postJson<StopRunResponse>(`/computers/${seg(id)}/runs/${seg(runId)}/stop`);
}

/** All runs of a computer, newest first. Served from control-plane data. */
export function fetchRuns(id: string, signal?: AbortSignal): Promise<RunListResponse> {
  return getJson<RunListResponse>(`/computers/${seg(id)}/runs`, signal);
}

/** One run's detail. */
export function fetchRun(id: string, runId: string, signal?: AbortSignal) {
  return getJson<RunListResponse['runs'][number]>(
    `/computers/${seg(id)}/runs/${seg(runId)}`,
    signal,
  );
}

/**
 * The run's changes against its pre-run manifest (spec 5.3). Manifest-only —
 * reading a diff never wakes a computer (spec 8.4 reasoning applies: a diff is
 * a function of two manifests, decisions.md).
 */
export function fetchRunDiff(id: string, runId: string, signal?: AbortSignal): Promise<DiffResponse> {
  return getJson<DiffResponse>(`/computers/${seg(id)}/runs/${seg(runId)}/diff`, signal);
}

/** Keep a run's changes (spec 5.3). */
export function keepRun(id: string, runId: string): Promise<ReviewResponse> {
  return postJson<ReviewResponse>(`/computers/${seg(id)}/runs/${seg(runId)}/keep`);
}

/** Restore the pre-run manifest, discarding the run's changes (spec 5.3). */
export function revertRun(id: string, runId: string): Promise<ReviewResponse> {
  return postJson<ReviewResponse>(`/computers/${seg(id)}/runs/${seg(runId)}/revert`);
}

/** Write a manifest now (spec 4.3, on a user command). */
export function snapshotComputer(id: string): Promise<SnapshotResponse> {
  return postJson<SnapshotResponse>(`/computers/${seg(id)}/snapshot`);
}

/** The SSE endpoint carrying content-free attention/run/state events (6.2). */
export function eventsUrl(): string {
  return `${API_BASE}/events`;
}

// ---- deployment configuration + the preview capability (spec 8.5) ----------
//
// These two exist because the browser-preview pane cannot be built from the
// bundle. The zone, the scheme, the origin port and the per-user host label are
// all facts about the DEPLOYMENT — the label is derived from the owner's account
// id — and the wake proxy requires a capability scoped to one computer and one
// port. The pane used to compose `https://{port}--{computer}--user.mari.sh` from
// a build-time env var and the literal string `'user'`, which could never
// resolve on a private instance and carried no authorization at all.

/** What this deployment is: preview zone/scheme, dev-auth availability, limits.
 *  Unauthenticated and content-free, so it can be read before sign-in. */
export function fetchConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  return getJson<ConfigResponse>('/config', signal);
}

/** The preview URL for one port of one computer, plus its capability. */
export function fetchPreview(
  id: string,
  port: number,
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  return getJson<PreviewResponse>(`/computers/${seg(id)}/preview?port=${port}`, signal);
}

// ---- lifecycle honesty: incidents + explicit wake -------------------------

/**
 * A computer's incident log: what Mari had to do that nobody asked for
 * (substrate lost, final snapshot missed, …). Content-free kinds; the interface
 * supplies the prose. A deployment without the route answers 404, and the
 * caller hides the surface — `null` here means "no such surface", never
 * "no incidents".
 */
export async function fetchIncidents(
  id: string,
  signal?: AbortSignal,
): Promise<IncidentsResponse | null> {
  try {
    const res = await getJson<Partial<IncidentsResponse>>(`/computers/${seg(id)}/incidents`, signal);
    // Defensive: an unexpected body shape must render as "nothing", not throw.
    return Array.isArray(res.incidents) ? { incidents: res.incidents } : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Wake a computer explicitly. The route is honest in every outcome (spec 8.3),
 * so this DECODES rather than throws: 200 is `ok`, 202 is `retrying` with the
 * time the DO will try again, and 503 is `refused` with the reason (e.g.
 * `substrate_not_configured`) and the state the computer actually landed in.
 * Only transport failures and auth reject.
 */
export async function wakeComputer(id: string): Promise<WakeOutcome> {
  const url = `${API_BASE}/computers/${seg(id)}/wake`;
  const res = noteAuth(
    await fetch(url, { method: 'POST', headers: { accept: 'application/json' } }),
  );
  if (res.status === 401 || res.status === 404) {
    throw new ApiError(`POST wake → ${res.status}`, res.status, url);
  }
  const body = (await readJsonOr(res, {})) as {
    state?: string;
    epoch?: number;
    error?: string;
    retrying?: boolean;
    retryAt?: number;
  };
  if (res.ok) {
    return {
      outcome: 'ok',
      state: (body.state ?? 'waking') as Extract<WakeOutcome, { outcome: 'ok' }>['state'],
      epoch: body.epoch,
    };
  }
  if (res.status === 202 || body.retrying === true) {
    return {
      outcome: 'retrying',
      state: (body.state ?? 'cold') as Extract<WakeOutcome, { outcome: 'retrying' }>['state'],
      retryAt: typeof body.retryAt === 'number' ? body.retryAt : null,
      error: body.error ?? 'wake_retrying',
    };
  }
  return {
    outcome: 'refused',
    state: (body.state ?? null) as Extract<WakeOutcome, { outcome: 'refused' }>['state'],
    error: body.error ?? 'wake_failed',
  };
}

// ---- credential vault (spec 10.1) -----------------------------------------
//
// Names travel; values are WRITE-ONLY. `GET` lists names, `PUT` stores a value
// that no response will ever echo back, `DELETE` rotates a name out. The
// supervisor injects the values into runs as environment variables; they never
// appear in an HTTP response, an event, or a journal.

/** The computer's secret NAMES (never values). */
export function fetchSecretNames(id: string, signal?: AbortSignal): Promise<SecretNamesResponse> {
  return getJson<SecretNamesResponse>(`/computers/${seg(id)}/secrets`, signal);
}

/** Store (or rotate) one secret. The value is never readable back. */
export async function putSecret(id: string, name: string, value: string): Promise<void> {
  const url = `${API_BASE}/computers/${seg(id)}/secrets/${seg(name)}`;
  const res = noteAuth(
    await fetch(url, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    }),
  );
  if (!res.ok) {
    const body = (await readJsonOr(res, {})) as { error?: string };
    throw new ApiError(body.error ?? `PUT secret → ${res.status}`, res.status, url);
  }
}

/** Delete one secret by name. */
export async function deleteSecret(id: string, name: string): Promise<void> {
  const url = `${API_BASE}/computers/${seg(id)}/secrets/${seg(name)}`;
  const res = noteAuth(await fetch(url, { method: 'DELETE', headers: { accept: 'application/json' } }));
  if (!res.ok) throw new ApiError(`DELETE secret → ${res.status}`, res.status, url);
}

// ---- usage + limits (spec 8.2 / 10.3 surfaces; hidden-if-absent) ----------
//
// Both endpoints are landing alongside this client. `null` means the
// deployment does not serve the endpoint (404), and the caller hides the
// surface entirely — the meter must never render zeros it did not measure.

/** One computer's metered usage, or null when the deployment has no meter. */
export async function fetchUsage(id: string, signal?: AbortSignal): Promise<UsageResponse | null> {
  try {
    const res = await getJson<Partial<UsageResponse>>(`/computers/${seg(id)}/usage`, signal);
    if (typeof res.awakeMs !== 'number' || typeof res.estimatedUsd !== 'number') return null;
    return { awakeMs: res.awakeMs, boxMs: typeof res.boxMs === 'number' ? res.boxMs : 0, estimatedUsd: res.estimatedUsd };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The account's compute limits, or null when the deployment has none. */
export async function fetchLimits(signal?: AbortSignal): Promise<LimitsResponse | null> {
  try {
    const res = await getJson<Partial<LimitsResponse>>('/me/limits', signal);
    if (typeof res.computeSecondsCap !== 'number' || typeof res.computeSecondsUsed !== 'number') {
      return null;
    }
    return {
      computeSecondsCap: res.computeSecondsCap,
      computeSecondsUsed: res.computeSecondsUsed,
      maxComputers: typeof res.maxComputers === 'number' ? res.maxComputers : 0,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
