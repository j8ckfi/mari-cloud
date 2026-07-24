// Registry + wake-scheduling (spec §3.6) unit tests. Pure logic — no daemon, no
// network.

import { describe, it, expect } from 'vitest';
import {
  selectSubstrate,
  createSubstrate,
  substrateRegistry,
  SUBSTRATE_NAMES,
  SUBSTRATE_PROFILES,
  DOCKER_SUBSTRATE,
  type SubstrateProfile,
} from '../../src/substrates/index.js';
import { DOCKER_SUBSTRATE as DOCKER_NAME_FROM_DRIVER } from '../../src/substrates/docker.js';
import { SPRITES_SUBSTRATE } from '../../src/substrates/sprites.js';

describe('selectSubstrate (spec §3.6)', () => {
  it('picks local Docker over Sprites by default (cheaper, faster, more capacity)', () => {
    expect(selectSubstrate(['sprites', 'docker'])).toBe(DOCKER_SUBSTRATE);
  });

  it('returns the sole candidate', () => {
    expect(selectSubstrate(['sprites'])).toBe(SPRITES_SUBSTRATE);
  });

  it('ignores candidates without a known profile', () => {
    expect(selectSubstrate(['bogus', 'docker'])).toBe('docker');
  });

  it('throws when no candidate has a known profile', () => {
    expect(() => selectSubstrate(['bogus', 'also-bogus'])).toThrow(/no candidate/);
    expect(() => selectSubstrate([])).toThrow(/no candidate/);
  });

  it('weights actually change the winner', () => {
    const profiles: Record<string, SubstrateProfile> = {
      fast: { usdPerHour: 10, capacity: 1, wakeLatencyMs: 10 },
      cheap: { usdPerHour: 1, capacity: 0.5, wakeLatencyMs: 1000 },
    };
    // Price-dominant selection prefers the cheap one.
    expect(
      selectSubstrate(['fast', 'cheap'], { price: 1, capacity: 0, latency: 0 }, profiles),
    ).toBe('cheap');
    // Latency-dominant selection prefers the fast one.
    expect(
      selectSubstrate(['fast', 'cheap'], { price: 0, capacity: 0, latency: 1 }, profiles),
    ).toBe('fast');
    // Capacity-dominant selection prefers the higher-capacity one.
    expect(
      selectSubstrate(['fast', 'cheap'], { price: 0, capacity: 1, latency: 0 }, profiles),
    ).toBe('fast');
  });

  it('breaks ties toward the earlier candidate', () => {
    const profiles: Record<string, SubstrateProfile> = {
      a: { usdPerHour: 5, capacity: 0.5, wakeLatencyMs: 500 },
      b: { usdPerHour: 5, capacity: 0.5, wakeLatencyMs: 500 },
    };
    expect(selectSubstrate(['a', 'b'], {}, profiles)).toBe('a');
    expect(selectSubstrate(['b', 'a'], {}, profiles)).toBe('b');
  });

  it('negative weights are clamped to zero (ignored), not inverted', () => {
    const profiles: Record<string, SubstrateProfile> = {
      fast: { usdPerHour: 10, capacity: 1, wakeLatencyMs: 10 },
      cheap: { usdPerHour: 1, capacity: 0.5, wakeLatencyMs: 1000 },
    };
    // With only latency active (price/capacity clamped from negative to 0), fast wins.
    expect(
      selectSubstrate(['cheap', 'fast'], { price: -5, capacity: -5, latency: 1 }, profiles),
    ).toBe('fast');
  });
});

describe('registry', () => {
  it('exposes both substrate names and their profiles', () => {
    expect([...SUBSTRATE_NAMES].sort()).toEqual(['docker', 'sprites']);
    expect(SUBSTRATE_PROFILES.docker).toBeDefined();
    expect(SUBSTRATE_PROFILES.sprites).toBeDefined();
    expect(SUBSTRATE_PROFILES.docker!.usdPerHour).toBe(0);
  });

  it('index DOCKER_SUBSTRATE matches the driver constant (no drift)', () => {
    expect(DOCKER_SUBSTRATE).toBe(DOCKER_NAME_FROM_DRIVER);
  });

  it('createSubstrate("sprites") returns a synchronous SpritesProvider', () => {
    const p = createSubstrate(SPRITES_SUBSTRATE, { token: 'tok' });
    expect(p.name).toBe('sprites');
    expect(typeof p.materialize).toBe('function');
    expect(typeof p.exposePort).toBe('function');
  });

  it('createSubstrate("docker") returns a Promise for a Node-only provider', async () => {
    const result = createSubstrate(DOCKER_SUBSTRATE);
    expect(result).toBeInstanceOf(Promise);
    const p = await result;
    expect(p.name).toBe('docker');
    // Has exactly the six-function surface.
    for (const fn of ['materialize', 'destroy', 'sleep', 'wake', 'exec', 'exposePort']) {
      expect(typeof (p as unknown as Record<string, unknown>)[fn]).toBe('function');
    }
  });

  it('registry object maps names to factories', () => {
    expect(typeof substrateRegistry.docker).toBe('function');
    expect(typeof substrateRegistry.sprites).toBe('function');
    const sp = substrateRegistry.sprites({ token: 'tok' });
    expect(sp.name).toBe('sprites');
  });

  it('createSubstrate throws on an unknown substrate', () => {
    expect(() => createSubstrate('nope' as 'sprites', { token: 't' })).toThrow(/unknown substrate/);
  });
});
