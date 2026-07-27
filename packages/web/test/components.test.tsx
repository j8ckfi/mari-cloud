import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FleetHome } from '../src/components/FleetHome';
import { CommandPalette } from '../src/components/CommandPalette';
import { CommandRegistry } from '../src/palette/registry';
import type { FleetComputer } from '../src/api/types';

function coldComputer(over: Partial<FleetComputer> = {}): FleetComputer {
  return {
    id: 'seed-cold',
    hostname: 'cold-box',
    state: 'cold',
    activeRuns: 0,
    attention: 2,
    changedFiles: 7,
    cost: { currency: 'USD', accrued: 12.34, ratePerHour: 0, window: 'month to date' },
    manifestHead: 'abcd',
    updatedAt: 1_700_000_000,
    ...over,
  };
}

describe('FleetHome (spec 8.2 / 8.3)', () => {
  it('renders a COLD computer fully with no spinner element', () => {
    render(<FleetHome computers={[coldComputer()]} onOpen={() => {}} />);

    const card = screen.getByTestId('computer-card');
    expect(within(card).getByTestId('computer-state').textContent).toBe('cold');
    expect(within(card).getByTestId('active-runs').textContent).toBe('0');
    expect(within(card).getByTestId('attention').textContent).toBe('2');
    expect(within(card).getByTestId('changed-files').textContent).toBe('7');
    expect(within(card).getByTestId('cost-meter').textContent).toContain('$12.34');

    // Spec 8.3: skeleton-free — no spinner/progressbar ever mounts.
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector('.spinner, [data-testid*="spinner"], [aria-busy="true"]')).toBeNull();
  });

  it('renders the empty state (not a spinner) before data arrives', () => {
    render(<FleetHome computers={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('fleet-empty')).toBeTruthy();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('invokes onOpen with the computer id when a card is activated', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<FleetHome computers={[coldComputer()]} onOpen={onOpen} />);
    await user.click(screen.getByTestId('computer-card'));
    expect(onOpen).toHaveBeenCalledWith('seed-cold');
  });
});

describe('CommandPalette (spec 8.1)', () => {
  function setup() {
    const ran: string[] = [];
    const registry = new CommandRegistry();
    registry.registerAll([
      { id: 'split', title: 'Split pane right', group: 'Window', run: () => ran.push('split') },
      { id: 'close', title: 'Close pane', group: 'Window', run: () => ran.push('close') },
      { id: 'theme', title: 'Toggle theme', run: () => ran.push('theme') },
    ]);
    return { registry, ran };
  }

  it('lists every command when open with an empty query', () => {
    const { registry } = setup();
    render(<CommandPalette registry={registry} open onClose={() => {}} />);
    expect(screen.getAllByTestId('palette-item')).toHaveLength(3);
  });

  it('fuzzy-filters as the user types', async () => {
    const { registry } = setup();
    const user = userEvent.setup();
    render(<CommandPalette registry={registry} open onClose={() => {}} />);
    await user.type(screen.getByTestId('palette-input'), 'close');
    const items = screen.getAllByTestId('palette-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.getAttribute('data-command-id')).toBe('close');
  });

  it('executes the selected command on Enter and closes', async () => {
    const { registry, ran } = setup();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette registry={registry} open onClose={onClose} />);
    await user.type(screen.getByTestId('palette-input'), 'theme');
    await user.keyboard('{Enter}');
    expect(ran).toEqual(['theme']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('executes a command on click', async () => {
    const { registry, ran } = setup();
    const user = userEvent.setup();
    render(<CommandPalette registry={registry} open onClose={() => {}} />);
    await user.click(screen.getByText('Close pane'));
    expect(ran).toEqual(['close']);
  });

  it('closes on Escape without running anything', async () => {
    const { registry, ran } = setup();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette registry={registry} open onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([]);
  });

  it('renders nothing when closed', () => {
    const { registry } = setup();
    const { container } = render(<CommandPalette registry={registry} open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
