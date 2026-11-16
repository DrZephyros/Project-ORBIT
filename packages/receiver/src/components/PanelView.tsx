import { useCallback, useRef } from 'react';
import type { InteractionMode, Panel, PanelRect } from '@orbit/shared';
import type { StreamSlot } from '../lib/streams.js';

interface Props {
  panel: Panel;
  mode: InteractionMode;
  stream: StreamSlot | undefined;
  scale: number;
  onSelect: (panelId: string) => void;
  onMove: (panelId: string, rect: PanelRect) => void;
  onClose: (panelId: string) => void;
  onReturn: (panelId: string) => void;
}

type DragKind = 'move' | 'resize';

interface DragState {
  kind: DragKind;
  pointerId: number;
  startX: number;
  startY: number;
  origin: PanelRect;
  moved: boolean;
}

const DRAG_THRESHOLD = 4;

/**
 * One workspace panel.
 *
 * In Arrange mode a drag moves or resizes the panel in the ORBIT canvas. In
 * Interact mode input goes to the application and panel geometry is locked,
 * which is the conflict described in section 4D of the plan.
 */
export function PanelView({ panel, mode, stream, scale, onSelect, onMove, onClose, onReturn }: Props) {
  const drag = useRef<DragState | null>(null);

  const begin = useCallback(
    (kind: DragKind) => (event: React.PointerEvent<HTMLElement>) => {
      if (mode !== 'arrange') return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      event.stopPropagation();
      onSelect(panel.id);

      drag.current = {
        kind,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: panel.rect,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [mode, onSelect, panel.id, panel.rect],
  );

  const move = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;

      const dx = (event.clientX - state.startX) / scale;
      const dy = (event.clientY - state.startY) / scale;

      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      state.moved = true;

      const next: PanelRect =
        state.kind === 'move'
          ? { ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy }
          : { ...state.origin, width: state.origin.width + dx, height: state.origin.height + dy };

      onMove(panel.id, next);
    },
    [onMove, panel.id, scale],
  );

  const end = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  const status = stream?.status ?? 'idle';
  const stats = stream?.stats ?? {};

  return (
    <div
      className={`panel${panel.selected ? ' selected' : ''}`}
      data-panel-id={panel.id}
      style={{
        left: panel.rect.x * scale,
        top: panel.rect.y * scale,
        width: panel.rect.width * scale,
        height: panel.rect.height * scale,
        zIndex: panel.z,
        cursor: mode === 'arrange' ? 'grab' : 'default',
      }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="group"
      aria-label={panel.title}
    >
      {stream?.stream ? (
        <video
          style={{ opacity: status === 'live' ? 1 : 0 }}
          ref={(el) => {
            if (el && el.srcObject !== stream.stream) {
              el.srcObject = stream.stream;
              // Safari needs an explicit play after the stream attaches.
              void el.play().catch(() => undefined);
            }
          }}
          playsInline
          muted
          autoPlay
        />
      ) : null}

      {/* The overlay stays until frames are actually flowing, not merely until a
          track exists. A negotiated track with no decoded frames is exactly the
          black rectangle this used to show: the video element was attached, the
          status was still not 'live', but nothing said so on top of the black. */}
      {status !== 'live' && (
        <div className="panel-status">
          {status === 'failed' ? (
            <>
              <span className="badge danger">Stream failed</span>
              <span>The panel is still yours to arrange or return.</span>
            </>
          ) : (
            <>
              <span className="spinner" />
              <span>
                {stream ? 'Negotiating stream…' : 'Waiting for video…'}
              </span>
            </>
          )}
        </div>
      )}

      <div className="panel-head">
        <span className="title">{panel.title}</span>
        {status === 'live' && stats.width ? (
          <span className="badge">{stats.width}×{stats.height}</span>
        ) : null}
        <span className="spacer" />
        <div className="panel-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="Return to laptop (stops sharing this panel)"
            aria-label="Return to laptop"
            onClick={() => onReturn(panel.id)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 2H3v11h3M10 5l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13 8H6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Close panel"
            aria-label="Close panel"
            onClick={() => onClose(panel.id)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {mode === 'arrange' && (
        <div
          className="resize-handle"
          onPointerDown={begin('resize')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
