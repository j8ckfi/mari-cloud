import { beforeEach, describe, expect, it } from 'vitest';
import { defaultLayout, useUiStore } from '../src/store/ui';

describe('account-scoped UI session reset', () => {
  beforeEach(() => {
    useUiStore.setState({
      view: 'fleet',
      workspaces: [],
      activeComputer: null,
      layouts: {},
      paletteOpen: false,
      notice: '',
    });
  });

  it('drops every prior-account workspace artifact on session end', () => {
    useUiStore.setState({
      view: 'workspace',
      workspaces: ['private-computer'],
      activeComputer: 'private-computer',
      layouts: { 'private-computer': defaultLayout() },
      paletteOpen: true,
      notice: 'Snapshot private-manifest',
    });

    useUiStore.getState().resetForSession();

    expect(useUiStore.getState()).toMatchObject({
      view: 'fleet',
      workspaces: [],
      activeComputer: null,
      layouts: {},
      paletteOpen: false,
      notice: '',
    });
  });
});
