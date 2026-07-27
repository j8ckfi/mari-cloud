// Incident presentation + dismissal (workspace notices).
//
// The control plane records CONTENT-FREE incidents — a kind, a time, an epoch —
// whenever it had to act on a fact nobody asked for (`GET
// /api/computers/:id/incidents`). The interface owns the prose: each kind maps
// to a plain-English explanation and one suggested action, because "your
// computer completed a transition WITHOUT the thing it asked for" must not read
// as a clean success (and must not read as jargon either).
//
// Dismissal is a CLIENT-side act: the server keeps its log (it is the audit
// trail), the user only silences the notice. Dismissals persist in
// localStorage so a page reload does not resurrect every notice ever shown —
// but a NEW incident (a higher id) always surfaces.

import { create } from 'zustand';
import type { IncidentKind, IncidentRecord } from '../api/types';

/** The user-facing reading of one incident kind. */
export interface IncidentCopy {
  title: string;
  body: string;
  action: string;
}

const COPY: Record<IncidentKind, IncidentCopy> = {
  substrate_lost: {
    title: 'The machine backing this computer disappeared',
    body: 'The instance your computer was running on no longer existed when Mari checked. The computer was recovered onto a fresh instance from its last snapshot; anything written after that snapshot on the lost instance is gone.',
    action: 'Check the runs list — a run that was executing has been re-queued or marked interrupted.',
  },
  substrate_unknown: {
    title: 'The substrate stopped answering',
    body: 'Mari could not ask the substrate whether this computer was still alive, repeatedly. Rather than leave it wedged, the computer was recovered from its last snapshot.',
    action: 'If this repeats, the substrate (e.g. your Docker daemon) is likely down or unreachable.',
  },
  supervisor_lost: {
    title: 'The computer’s supervisor went silent',
    body: 'The instance was alive but its supervisor stopped responding while work was pending, so Mari recovered the computer onto a fresh instance. Queued work runs exactly once.',
    action: 'Check the runs list to confirm your work continued.',
  },
  final_snapshot_missed: {
    title: 'Deep sleep completed without a final snapshot',
    body: 'The computer went to deep sleep, but its supervisor never delivered the final snapshot. The filesystem is at the last snapshot that did arrive — changes made after it were not captured.',
    action: 'Open the file browser to verify what is there; re-run anything whose output is missing.',
  },
  destroy_failed: {
    title: 'An old instance could not be cleaned up',
    body: 'Mari asked the substrate to destroy an instance this computer no longer uses and the destroy did not succeed. The computer itself moved on and is unaffected.',
    action: 'If you operate the substrate yourself, the stray instance may need a manual remove.',
  },
  wake_abandoned: {
    title: 'A wake was interrupted',
    body: 'A wake was left mid-flight — the platform evicted the process or the substrate call ran over its budget — and was rolled back. The computer is in deep sleep, unchanged, with any queued work preserved.',
    action: 'Start a run or open a terminal to wake it again.',
  },
  recovery_exhausted: {
    title: 'Recovery gave up after repeated attempts',
    body: 'Mari tried to recover this computer several times without a supervisor ever connecting. It has been left in deep sleep at its last snapshot, with queued work preserved — nothing was discarded.',
    action: 'Check that the substrate is healthy, then start a run to try again.',
  },
};

const FALLBACK: IncidentCopy = {
  title: 'Something unexpected happened to this computer',
  body: 'The control plane recorded an incident this interface does not recognize. The computer’s state above is still the truth.',
  action: 'Check the runs list and the file browser; report the incident kind if it repeats.',
};

/** Plain-English reading of an incident. Total over unknown kinds. */
export function incidentCopy(kind: string): IncidentCopy {
  return (COPY as Record<string, IncidentCopy>)[kind] ?? FALLBACK;
}

// ---- dismissal ------------------------------------------------------------

const STORAGE_KEY = 'mari.dismissedIncidents.v1';

/** `computer/id` — the stable identity of one incident notice. */
export function incidentKey(computer: string, incident: Pick<IncidentRecord, 'id'>): string {
  return `${computer}/${incident.id}`;
}

function loadDismissed(): Record<string, true> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const k of Object.keys(parsed as Record<string, unknown>)) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

function saveDismissed(dismissed: Record<string, true>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(dismissed));
  } catch {
    // Private mode / quota: dismissal just won't survive a reload.
  }
}

interface IncidentUiState {
  dismissed: Record<string, true>;
  dismiss(computer: string, incident: Pick<IncidentRecord, 'id'>): void;
  isDismissed(computer: string, incident: Pick<IncidentRecord, 'id'>): boolean;
  /** Test seam. */
  resetDismissals(): void;
}

export const useIncidentUiStore = create<IncidentUiState>((set, get) => ({
  dismissed: loadDismissed(),
  dismiss: (computer, incident) =>
    set((s) => {
      const dismissed = { ...s.dismissed, [incidentKey(computer, incident)]: true as const };
      saveDismissed(dismissed);
      return { dismissed };
    }),
  isDismissed: (computer, incident) =>
    get().dismissed[incidentKey(computer, incident)] === true,
  resetDismissals: () => {
    saveDismissed({});
    set({ dismissed: {} });
  },
}));

/** The incidents still worth showing, newest first. */
export function visibleIncidents(
  computer: string,
  incidents: readonly IncidentRecord[],
  dismissed: Readonly<Record<string, true>>,
): IncidentRecord[] {
  return incidents.filter((i) => dismissed[incidentKey(computer, i)] !== true);
}
