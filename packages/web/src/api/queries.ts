// TanStack Query wiring for server state (decisions.md: TanStack Query for
// server state, zustand for UI/WM state).
//
// Spec 8.3 is load-bearing here: views render from control-plane data as it
// arrives and NEVER block behind a spinner. So these queries are configured to
// keep previous data on refetch and to surface partial data immediately; the
// UI reads `data` (possibly from cache) and simply renders nothing extra while
// a background refetch runs — it must not mount a spinner.

import { QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchComputer, fetchDir, fetchFleet, fetchLayout } from './client';
import type { ComputerDetail, DirListing, FleetResponse, LayoutResponse } from './types';

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
