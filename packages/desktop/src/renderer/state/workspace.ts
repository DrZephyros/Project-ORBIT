import type { InteractionMode, Panel, PanelRect, SourceCatalog, WorkspaceState } from '@orbit/shared';
import { PANEL_LIMITS, applyAspect, clampRect, topZ } from '@orbit/shared';

/**
 * The desktop owns workspace truth. Every receiver mutation round-trips through
 * here, then the whole state is echoed back so all receivers converge.
 */

export const CANVAS = { width: 1024, height: 768 };

export function emptyWorkspace(): WorkspaceState {
  return { mode: 'arrange', panels: [], canvas: CANVAS };
}

export function addPanel(
  state: WorkspaceState,
  input: { sourceId: string; title: string; kind: 'live' | 'native'; aspectRatio?: number },
): { state: WorkspaceState; panel: Panel } {
  // Cascade new panels so two broadcasts never land exactly on top.
  const count = state.panels.length;
  const offset = (count % 5) * 34;
  const base: PanelRect = clampRect(
    {
      x: 60 + offset,
      y: 60 + offset,
      width: Math.round(CANVAS.width * 0.55),
      height: Math.round(CANVAS.height * 0.5),
    },
    CANVAS,
  );

  const rect = applyAspect(base, input.aspectRatio);

  const panel: Panel = {
    id: crypto.randomUUID(),
    sourceId: input.sourceId,
    title: input.title,
    rect: clampRect(rect, CANVAS),
    z: topZ(state.panels) + 1,
    selected: true,
    kind: input.kind,
    connected: true,
    minWidth: PANEL_LIMITS.minWidth,
    minHeight: PANEL_LIMITS.minHeight,
    aspectRatio: input.aspectRatio,
  };

  return {
    state: {
      ...state,
      panels: [...state.panels.map((p) => ({ ...p, selected: false })), panel],
    },
    panel,
  };
}

export function selectPanel(state: WorkspaceState, panelId: string): WorkspaceState {
  const panels = state.panels.map((p) =>
    p.id === panelId
      ? { ...p, selected: true, z: topZ(state.panels) + 1 }
      : { ...p, selected: false },
  );
  return { ...state, panels };
}

export function movePanel(state: WorkspaceState, panelId: string, rect: PanelRect): WorkspaceState {
  const panels = state.panels.map((p) => {
    if (p.id !== panelId) return p;
    // Enforce minimums and aspect ratio before clamping to the canvas: doing it
    // in that order prevents a resize from squeezing a 16:9 panel.
    const withMin: PanelRect = {
      ...rect,
      width: Math.max(rect.width, p.minWidth),
      height: Math.max(rect.height, p.minHeight),
    };
    return { ...p, rect: clampRect(applyAspect(withMin, p.aspectRatio), CANVAS) };
  });
  return { ...state, panels };
}

export function removePanel(state: WorkspaceState, panelId: string): WorkspaceState {
  const panels = state.panels.filter((p) => p.id !== panelId);
  const nextSelected = panels.length > 0 ? panels[panels.length - 1]!.id : null;
  return {
    ...state,
    panels: panels.map((p) => ({ ...p, selected: p.id === nextSelected })),
  };
}

export function setMode(state: WorkspaceState, mode: InteractionMode): WorkspaceState {
  return { ...state, mode };
}

export function setConnected(state: WorkspaceState, panelId: string, connected: boolean): WorkspaceState {
  return { ...state, panels: state.panels.map((p) => (p.id === panelId ? { ...p, connected } : p)) };
}

/** Which source is the remembered broadcast target. */
export function activeSource(catalog: SourceCatalog | null): string | null {
  if (!catalog) return null;
  if (catalog.activeSourceId && catalog.sources.some((s) => s.id === catalog.activeSourceId)) {
    return catalog.activeSourceId;
  }
  return catalog.sources[0]?.id ?? null;
}

/**
 * Move a panel to another device (or back to the laptop with `null`).
 *
 * The panel keeps its geometry so returning it lands where it was. Assigning
 * the device it is already on is a no-op rather than an error: the gaze is a
 * best-effort signal, and "nothing changed" is the honest outcome.
 */
export function assignPanelDevice(
  state: WorkspaceState,
  panelId: string,
  deviceId: string | null,
): WorkspaceState {
  const panels = state.panels.map((p) =>
    p.id === panelId ? { ...p, ownerDeviceId: deviceId, selected: true } : p,
  );
  return { ...state, panels };
}
