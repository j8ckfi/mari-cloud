import { useRef } from 'react';
import type { WmNode } from '../wm/tree';
import { useUiStore } from '../store/ui';
import { PaneHost } from './panes/PaneHost';

/**
 * Recursively render a WM tree. Splits become flex containers with a draggable
 * gutter; leaves become {@link PaneHost}. The flex-basis of child `a` follows
 * the split ratio, so resizing is a single flex-basis update. Rendering is a
 * pure function of the tree (the tested `wm/tree` module owns all the math).
 */
export function TileView({
  node,
  computer,
  user,
  focusedId,
}: {
  node: WmNode;
  computer: string;
  user: string;
  focusedId: string | null;
}) {
  if (node.type === 'pane') {
    return (
      <PaneHost
        paneId={node.id}
        pane={node.pane}
        computer={computer}
        user={user}
        focused={node.id === focusedId}
      />
    );
  }
  return (
    <Split node={node} computer={computer} user={user} focusedId={focusedId} />
  );
}

function Split({
  node,
  computer,
  user,
  focusedId,
}: {
  node: Extract<WmNode, { type: 'split' }>;
  computer: string;
  user: string;
  focusedId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const resizeSplit = useUiStore((s) => s.resizeFocusedSplit);

  const onGutterDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    const container = ref.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: MouseEvent): void => {
      const ratio =
        node.axis === 'row'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      resizeSplit(node.id, ratio);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const pct = `${(node.ratio * 100).toFixed(3)}%`;
  return (
    <div className={`tile-split ${node.axis}`} ref={ref} data-testid="tile-split" data-axis={node.axis}>
      <div style={{ flex: `0 0 ${pct}`, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <TileView node={node.a} computer={computer} user={user} focusedId={focusedId} />
      </div>
      <div className="tile-gutter" onMouseDown={onGutterDown} data-testid="tile-gutter" />
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex' }}>
        <TileView node={node.b} computer={computer} user={user} focusedId={focusedId} />
      </div>
    </div>
  );
}
