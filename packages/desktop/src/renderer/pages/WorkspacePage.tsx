import { useEffect, useRef, useState } from 'react';
import type { SharedProps } from '../App.js';
import { CANVAS } from '../state/workspace.js';

/**
 * Workspace page.
 *
 * There is no "broadcast" button. Choosing a window selects what a fist grab
 * picks up; the window only reaches the iPad when the hand opens while the user
 * is looking at it. The canvas mirrors the workspace, with a laptop-owned panel
 * marked as such, so "what is on the iPad" is always visible at a glance.
 */
export function WorkspacePage({ state, refreshSources, setActiveSource, returnPanel, stopSession }: SharedProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const connected = (state.session?.receivers.length ?? 0) > 0;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => {
      const rect = el.getBoundingClientRect();
      if (!rect.width) return;
      setScale(rect.width / CANVAS.width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  const active = state.sources.find((s) => s.id === state.activeSourceId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workspace</h1>
          <p>
            Pick the window a grab picks up. Grab with your hand, then open it while looking at the
            iPad to send the window there. Closing a panel never closes the application.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" onClick={() => void refreshSources()}>
            Refresh windows
          </button>
          {state.streaming ? (
            <button className="btn btn-danger" onClick={() => void stopSession()}>
              {connected ? 'Stop sharing' : 'End session'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>
          Grab target
          <span className="sub">
            {!connected
              ? 'Connect your iPad on the Setup tab'
              : active
                ? `Next grab picks up ${active.name}`
                : 'No window chosen'}
          </span>
        </h2>

        {state.sources.length === 0 ? (
          <div className="empty">
            No shareable windows found. Open the application you want to share, then press Refresh
            windows.
          </div>
        ) : (
          <div className="source-list">
            {state.sources.map((source) => (
              <button
                key={source.id}
                className={`source${source.id === state.activeSourceId ? ' active' : ''}`}
                onClick={() => void setActiveSource(source.id)}
                title={source.name}
              >
                <span className="thumb">
                  {source.thumbnailDataUrl ? (
                    <img src={source.thumbnailDataUrl} alt="" />
                  ) : (
                    <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>No preview</span>
                  )}
                </span>
                <span className="label">{source.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>
          iPad canvas
          <span className="sub">
            {state.workspace.panels.length} panel{state.workspace.panels.length === 1 ? '' : 's'} ·{' '}
            {state.workspace.mode === 'arrange' ? 'Arrange mode' : 'Interact mode'}
          </span>
        </h2>

        <div className="canvas-wrap" ref={wrapRef}>
          {state.workspace.panels.length === 0 ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--text-faint)',
                fontSize: 13,
                textAlign: 'center',
                padding: 24,
              }}
            >
              {connected
                ? 'Nothing held yet. Choose a window above, grab it with your hand, then look at the iPad and open your hand.'
                : 'Connect your iPad on the Setup tab. A window appears there only when a grab is released while looking at it.'}
            </div>
          ) : (
            state.workspace.panels.map((panel) => (
              <div
                key={panel.id}
                data-panel-id={panel.id}
                className={`panel-frame${panel.selected ? ' selected' : ''}`}
                style={{
                  left: panel.rect.x * scale,
                  top: panel.rect.y * scale,
                  width: panel.rect.width * scale,
                  height: panel.rect.height * scale,
                  zIndex: panel.z,
                }}
              >
                <div className="panel-bar">
                  <span className={`dot ${panel.connected ? 'online' : 'offline'}`} />
                  <span className="name">{panel.title}</span>
                  <span className="mono" style={{ opacity: 0.5 }}>
                    {Math.round(panel.rect.width)}×{Math.round(panel.rect.height)}
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => void returnPanel(panel.id)}
                    title="Stop sharing this panel and remove it from the iPad"
                  >
                    Return
                  </button>
                </div>
                <div className="panel-body">
                  <span>{panel.ownerDeviceId ? 'On the iPad' : 'Held on the laptop'}</span>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    {panel.ownerDeviceId
                      ? 'Review locally without duplicating the stream.'
                      : 'Look at the iPad and open your hand to send it over.'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
