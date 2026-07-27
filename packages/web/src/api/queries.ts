// TanStack Query wiring for server state (decisions.md: TanStack Query for
// server state, zustand for UI/WM state).
//
// Spec 8.3 is load-bearing here: views render from control-plane data as it
// arrives and NEVER block behind a spinner. So these queries are configured to
// keep previous data on refetch and to surface partial data immediately; the
// UI reads `data` (possibly from cache) and simply renders nothing extra while
// a background refetch runs — it must not mount a spinner.

import { QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  fetchComputer,
  fetchDir,
  fetchFleet,
  fetchIncidents,
  fetchLayout,
  fetchLimits,
  fetchRunDiff,
  fetchRuns,
  fetchSecretNames,
  fetchUsage,
} from './client';
import type {
  ComputerDetail,
  DiffResponse,
  DirListing,
  FleetResponse,
  IncidentsResponse,
  LayoutResponse,
  LimitsResponse,
  RunListResponse,
  SecretNamesResponse,
  UsageResponse,
} from './types';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Fleet/manifest data is cheap and control-plane-authoritative; refetch
        // on focus keeps it live without ever blocking the first paint.
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        retry: 1,
        // Never throw to a spinner; render whatever we have.
        placeholderData: (prev: unknown) => prev,
      },
    },
  });
}

export const queryKeys = {
  fleet: ['fleet'] as const,
  computer: (id: string) => ['computer', id] as const,
  dir: (id: string, path: string) => ['dir', id, path] as const,
  layout: (id: string) => ['layout', id] as const,
  runs: (id: string) => ['runs', id] as const,
  runDiff: (id: string, run: string) => ['run-diff', id, run] as const,
  incidents: (id: string) => ['incidents', id] as const,
  secrets: (id: string) => ['secrets', id] as const,
  usage: (id: string) => ['usage', id] as const,
  limits: ['limits'] as const,
};

export function useFleet(): UseQueryResult<FleetResponse> {
  return useQuery({
    queryKey: queryKeys.fleet,
    queryFn: ({ signal }) => fetchFleet(signal),
  });
}

export function useComputer(id: string | null): UseQueryResult<ComputerDetail> {
  return useQuery({
    queryKey: queryKeys.computer(id ?? ''),
    queryFn: ({ signal }) => fetchComputer(id as string, signal),
    enabled: id !== null,
  });
}

export function useDir(id: string | null, path: string): UseQueryResult<DirListing> {
  return useQuery({
    queryKey: queryKeys.dir(id ?? '', path),
    queryFn: ({ signal }) => fetchDir(id as string, path, signal),
    enabled: id !== null,
  });
}

export function useLayout(id: string | null): UseQueryResult<LayoutResponse> {
  return useQuery({
    queryKey: queryKeys.layout(id ?? ''),
    queryFn: ({ signal }) => fetchLayout(id as string, signal),
    enabled: id !== null,
  });
}

/**
 * A computer's runs (spec 5). Polled slowly: the live truth arrives on the
 * event stream (spec 6.2 / 5.5), and this is the durable backstop for a client
 * that just loaded or missed a push. It never blocks a render (spec 8.3).
 */
export function useRuns(id: string | null): UseQueryResult<RunListResponse> {
  return useQuery({
    queryKey: queryKeys.runs(id ?? ''),
    queryFn: ({ signal }) => fetchRuns(id as string, signal),
    enabled: id !== null,
    refetchInterval: 15_000,
  });
}

/**
 * A computer's incident log (what Mari had to do that nobody asked for).
 * `data === null` means the deployment has no incident route — hide the
 * surface, don't render an empty one. Polled slowly; incidents are rare and
 * durable.
 */
export function useIncidents(id: string | null): UseQueryResult<IncidentsResponse | null> {
  return useQuery({
    queryKey: queryKeys.incidents(id ?? ''),
    queryFn: ({ signal }) => fetchIncidents(id as string, signal),
    enabled: id !== null,
    refetchInterval: 30_000,
  });
}

/** A computer's secret NAMES (spec 10.1 — values never travel). */
export function useSecretNames(id: string | null): UseQueryResult<SecretNamesResponse> {
  return useQuery({
    queryKey: queryKeys.secrets(id ?? ''),
    queryFn: ({ signal }) => fetchSecretNames(id as string, signal),
    enabled: id !== null,
  });
}

/**
 * A computer's metered usage. `data === null` means the deployment has no
 * meter (404) and the surface hides cleanly (spec 8.2 renders it only when
 * something real was measured).
 */
export function useUsage(id: string | null): UseQueryResult<UsageResponse | null> {
  return useQuery({
    queryKey: queryKeys.usage(id ?? ''),
    queryFn: ({ signal }) => fetchUsage(id as string, signal),
    enabled: id !== null,
    refetchInterval: 30_000,
  });
}

/** The account's compute limits, or null when the deployment has none. */
export function useLimits(): UseQueryResult<LimitsResponse | null> {
  return useQuery({
    queryKey: queryKeys.limits,
    queryFn: ({ signal }) => fetchLimits(signal),
    refetchInterval: 60_000,
  });
}

/** One run's difference against its pre-run manifest (spec 5.3). */
export function useRunDiff(id: string | null, run: string | null): UseQueryResult<DiffResponse> {
  return useQuery({
    queryKey: queryKeys.runDiff(id ?? '', run ?? ''),
    queryFn: ({ signal }) => fetchRunDiff(id as string, run as string, signal),
    enabled: id !== null && run !== null,
    // A finished run's diff is immutable; a live one's changes as it writes.
    staleTime: 2_000,
  });
}
