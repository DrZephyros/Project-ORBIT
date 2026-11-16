import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  InteractionMode,
  Panel,
  PanelRect,
  SessionInfo,
  SourceCatalog,
  TaskState,
  TranscriptEvent,
  WorkspaceState,
} from '@orbit/shared';
import { clampRect } from '@orbit/shared';
import type { LinkState } from '../lib/link.js';
import type { StreamSlot } from '../lib/streams.js';
import { PanelView } from './PanelView.js';
import { Overlays } from './Overlays.js';

interface Props {
  state: LinkState;
  session: SessionInfo | null;
  sources: SourceCatalog | null;
  workspace: WorkspaceState | null;
  streams: Record<string, StreamSlot>;
  overlays: LiveOverlays;
  onMove: (panelId: string, rect: PanelRect) => void;
  onSelect: (panelId: string) => void;
  onClose: (panelId: string) => void;
  onReturn: (panelId: string) => void;
  onMode: (mode: InteractionMode) => void;
  onStop: () => void;
  onCommand: (text: string) => void;
  onApproval: (approvalId: string, accept: boolean) => void;
  onDismissApproval: () => void;
}

export interface LiveOverlays {
  voiceState: 'idle' | 'listening' | 'transcribing';
  transcript: TranscriptEvent | null;
  task: TaskState | null;
  approval: ApprovalRequest | null;
}

/**
 * Workspace shell.
 *
 * The desktop is the source of truth for panel geometry. While the user drags
 * we render a local optimistic rect, then send the change and accept whatever
 * the desktop echoes back, so two receivers cannot diverge.
 */
export function Workspace({
  state,
  session,
  sources,
  workspace,
  streams,
  overlays,
  onMove,
  onSelect,
  onClose,
  onReturn,
  onMode,
  onStop,
  onCommand,
  onApproval,
  onDismissApproval,
}: Props) {
  const [optimistic, setOptimistic] = useState<Record<string, PanelRect>>({});
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  const mode = workspace?.mode ?? 'arrange';
  const canvasSize = workspace?.canvas ?? { width: 1024, height: 768 };

  // Fit the logical canvas to the viewport, keeping panels proportional and
  // letterboxing rather than distorting them.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = (): void => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setScale(Math.min(rect.width / canvasSize.width, rect.height / canvasSize.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('orientationchange', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', update);
    };
  }, [canvasSize.width, canvasSize.height]);

  const panels = useMemo(() => workspace?.panels ?? [], [workspace]);

  const handleMove = useCallback(
    (panelId: string, rect: PanelRect) => {
      const clamped = clampRect(rect, canvasSize);
      setOptimistic((prev) => ({ ...prev, [panelId]: clamped }));
      onMove(panelId, clamped);
    },
    [canvasSize, onMove],
  );

  // Drop optimistic rects once the desktop confirms the same geometry.
  useEffect(() => {
    if (!workspace) return;
    setOptimistic((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const panel of workspace.panels) {
        const local = next[panel.id];
        if (!local) continue;
        const close =
          Math.abs(local.x - panel.rect.x) < 1 &&
          Math.abs(local.y - panel.rect.y) < 1 &&
          Math.abs(local.width - panel.rect.width) < 1 &&
          Math.abs(local.height - panel.rect.height) < 1;
        if (close) {
          delete next[panel.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [workspace]);

  const selected = panels.find((p) => p.selected);

  const resolveRect = (panel: Panel): PanelRect => optimistic[panel.id] ?? panel.rect;

  return (
    <div className="ws">
      <header className="ws-bar">
        <h2>Workspace</h2>
        <div className="mode-toggle" role="tablist" aria-label="Interaction mode">
          <button
            className={mode === 'arrange' ? 'active' : ''}
            onClick={() => onMode('arrange')}
            role="tab"
            aria-selected={mode === 'arrange'}
          >
            Arrange
          </button>
          <button
            className={mode === 'interact' ? 'active' : ''}
            onClick={() => onMode('interact')}
            role="tab"
            aria-selected={mode === 'interact'}
          >
            Interact
          </button>
        </div>
        <span className="status">
          <span
            className={`status-dot ${
              state === 'paired' ? (session?.phase === 'live' ? 'live' : 'warn') : 'bad'
            }`}
          />
          {linkLabel(state, session)}
        </span>
      </header>

      {state !== 'paired' && (
        <div className="banner" role="status">
          <span className="spinner" />
          {state === 'reconnecting'
            ? 'Connection lost. Reconnecting — panels stay where you left them.'
            : state === 'offline'
              ? 'Laptop unreachable. Showing the last known workspace.'
              : 'Reconnecting…'}
        </div>
      )}

      <div className="canvas" ref={canvasRef} onPointerDown={() => undefined}>
        {panels.length === 0 ? (
          <div className="canvas-empty">
            <span className="badge">No panels yet</span>
            <span>Grab a window on your laptop, look at this iPad, and open your hand to send it here.</span>
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              width: canvasSize.width * scale,
              height: canvasSize.height * scale,
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          >
            {panels.map((panel) => (
              <PanelView
                key={panel.id}
                panel={{ ...panel, rect: resolveRect(panel) }}
                mode={mode}
                stream={streams[panel.id]}
                scale={scale}
                onSelect={onSelect}
                onMove={handleMove}
                onClose={onClose}
                onReturn={onReturn}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="ws-foot">
        <span className="foot-hint">{selected ? `Selected: ${selected.title}` : 'Tap a panel to select it'}</span>
        <button className="btn btn-danger" onClick={onStop}>
          Stop
        </button>
      </footer>

      <Overlays
        voiceState={overlays.voiceState}
        transcript={overlays.transcript}
        task={overlays.task}
        approval={overlays.approval}
        onCommand={onCommand}
        onApproval={onApproval}
        onDismissApproval={onDismissApproval}
      />
    </div>
  );
}

function linkLabel(state: LinkState, session: SessionInfo | null): string {
  if (state === 'offline') return 'Offline';
  if (state === 'reconnecting' || state === 'connecting') return 'Reconnecting';
  if (!session) return 'Connected';
  switch (session.phase) {
    case 'live':
      return 'Live';
    case 'awaiting-receiver':
      return 'Waiting';
    case 'paused':
      return 'Paused';
    case 'ended':
      return 'Ended';
    default:
      return 'Idle';
  }
}

