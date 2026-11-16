import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalRequest,
  InteractionMode,
  PairingOffer,
  PanelRect,
  SessionInfo,
  TaskState,
  WorkspaceState,
  WindowSource,
} from '@orbit/shared';
import { api, on } from './env.js';
import { useSenders } from './hooks/useSenders.js';
import { addPanel, assignPanelDevice, emptyWorkspace, movePanel, removePanel, selectPanel, setMode } from './state/workspace.js';
import { Sidebar, type PageId } from './components/Sidebar.js';
import { GesturesPage } from './pages/GesturesPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';

export interface AppState {
  link: 'connecting' | 'online' | 'offline';
  session: SessionInfo | null;
  pairing: PairingOffer | null;
  sources: WindowSource[];
  activeSourceId: string | null;
  workspace: WorkspaceState;
  task: TaskState | null;
  approval: ApprovalRequest | null;
  error: { code: string; message: string; at: number } | null;
  streaming: boolean;
  /** Drive the real Windows pointer instead of drawing an in-app cursor. */
  systemPointer: boolean;
}

export function App() {
  const [page, setPage] = useState<PageId>('setup');
  const [state, setState] = useState<AppState>({
    link: 'connecting',
    session: null,
    pairing: null,
    sources: [],
    activeSourceId: null,
    workspace: emptyWorkspace(),
    task: null,
    approval: null,
    error: null,
    streaming: false,
    systemPointer: true,
  });

  const senders = useSenders(state.streaming);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sendersRef = useRef(senders);
  sendersRef.current = senders;

  /**
   * The panel a fist is currently holding.
   *
   * Set on `window.grab`, consumed on `window.release`. Routing the release
   * through this id means the window that is moved is the one that was picked
   * up, even if the selection changed while the hand was closed.
   */
  const heldPanel = useRef<string | null>(null);
  /** The panel just released, kept for the `window.handoff` that can follow. */
  const lastReleasedPanel = useRef<string | null>(null);
  /**
   * When the current fist grab started, or 0.
   *
   * The grab and the capture-source resolution are two events: the helper only
   * knows the window handle a few milliseconds after the gesture. This lets a
   * source that arrives long after the fact be recognised as stale.
   */
  const grabStartedAt = useRef(0);
  /** The window handle the current carry picked up, for the hand-off mapping. */
  const grabbedHwnd = useRef<string | null>(null);
  /** Title of the window being carried toward the iPad, for its preview card. */
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  /** Latest decoded gaze target, mirrored for the pinch-click handler. */
  const gazeTarget = useRef<'laptop' | 'tablet' | null>(null);
  /** A pinch down was relayed to the iPad and still owes it an up. */
  const tabletPressed = useRef(false);
  /** The DOM element a system-pointer-off pinch pressed, for the fallback. */
  const domPressed = useRef<Element | null>(null);
  const lastPointer = useRef({ visible: false, x: 0.5, y: 0.5, at: 0 });
  /** The finger cursor drawn inside the ORBIT window (the real mouse stays). */
  const [handCursor, setHandCursor] = useState<{ x: number; y: number } | null>(null);

  /**
   * Make sure a session exists before a window is streamed. Starting it sends
   * the source catalog to the receiver; it deliberately does not begin capture,
   * because grabbing a window must leave it on the laptop until the hand opens.
   */
  const ensureSession = useCallback(async (sourceId: string): Promise<void> => {
    if (stateRef.current.streaming) return;
    await api().startSession({ sources: stateRef.current.sources, activeSourceId: sourceId });
    setState((s) => ({ ...s, streaming: true }));
  }, []);

  // ------------------------------------------------------------------------
  // Initial load
  // ------------------------------------------------------------------------
  useEffect(() => {
    void (async () => {
      const status = await api().getStatus();
      const prefs = await api().getPrefs();
      setState((s) => ({
        ...s,
        link: status.link,
        session: status.session,
        pairing: status.pairing,
        activeSourceId: prefs.broadcastSourceId,
        systemPointer: prefs.systemPointer !== false,
      }));
      if (!prefs.onboardingComplete) setPage('setup');
    })();
  }, []);

  // ------------------------------------------------------------------------
  // Main -> renderer events
  // ------------------------------------------------------------------------
  useEffect(() => {
    const offs = [
      on('orbit:ev-status', (status) => {
        setState((s) => ({
          ...s,
          link: status.link,
          session: status.session,
          // Do not fall back to the cached offer: when the server clears or
          // rotates the pairing, a stale code must not stay on screen.
          pairing: status.pairing ?? null,
          error: status.lastError ?? s.error,
        }));
      }),
      on('orbit:ev-pairing', (pairing) => {
        setState((s) => ({ ...s, pairing: pairing as PairingOffer }));
      }),
      on('orbit:ev-workspace', (next) => {
        // The desktop remains the authority; only receiver-driven changes are
        // adopted when we are not the one that just wrote them.
        setState((s) => ({ ...s, workspace: next as WorkspaceState }));
      }),
      on('orbit:ev-panel-select', (panelId) => {
        setState((s) => ({ ...s, workspace: selectPanel(s.workspace, panelId) }));
      }),
      // A fist held up in front grabs the active window. Nothing is sent to the
      // iPad yet: the destination is only decided when the hand opens, and the
      // service attaches that decision to `window.release` as `detail.gaze`.
      //
      // Which *window* that is comes from the main process, not from here.
      //
      // Reported: "it was a small black window with the title status." This branch
      // used to take `sources[0]` from its own enumeration on the theory that
      // desktopCapturer lists windows frontmost-first - and a hidden helper window
      // with a black surface sits at the front of that list, so the panel streamed
      // a window that has no pixels. Only the main process knows the HWND the
      // PowerShell helper actually grabbed, and a capture source id is
      // `window:<hwnd>:0`, so it names the source and sends it as `grabTarget`.
      on('orbit:ev-gesture-event', (event) => {
        if (event.kind === 'window.grab') {
          // Start of a carry. The panel is created when `orbit:ev-grab-target`
          // arrives, a few milliseconds later.
          grabStartedAt.current = Date.now();
          return;
        }

        if (event.kind === 'window.handoff') {
          // The window was dragged past the edge of the laptop while the user was
          // looking at the iPad. This is the only path that moves a window to the
          // tablet; see the note on `window.release` below.
          const panelId = heldPanel.current ?? lastReleasedPanel.current;
          heldPanel.current = null;
          lastReleasedPanel.current = null;
          const current = stateRef.current;
          // The hand-off names the window it means, by handle. Prefer that over
          // any remembered id: the ids are bookkeeping here, while the handle is
          // the window the hand actually picked up.
          const handedHwnd =
            typeof event.detail?.hwnd === 'string' ? event.detail.hwnd : null;
          const byHandle = handedHwnd
            ? current.workspace.panels.find((p) => p.sourceId.startsWith(`window:${handedHwnd}:`))
            : undefined;
          const panel =
            byHandle ??
            (panelId
              ? current.workspace.panels.find((p) => p.id === panelId)
              : current.workspace.panels.find((p) => p.selected));
          if (!panel) return;

          const destination = current.session?.receivers[0];
          if (!destination) {
            setState((s) => ({
              ...s,
              error: {
                code: 'gaze',
                message: 'Dragged the window off the screen, but no iPad is connected.',
                at: Date.now(),
              },
            }));
            return;
          }

          setState((s) => ({
            ...s,
            workspace: assignPanelDevice(s.workspace, panel.id, destination.id),
            error: null,
          }));
          // Tell the main process which window this panel is showing, so the
          // iPad's cursor, button and keyboard can reach the real application
          // instead of a drawing of one. The event names the handle the fist
          // picked up, which is the only handle we can trust here.
          void api()
            .registerCastPanel(panel.id, handedHwnd ?? grabbedHwnd.current)
            .catch(() => undefined);
          void sendersRef.current.start(panel.id, panel.sourceId).catch((error) => {
            // Capture failed: put the panel back on the laptop rather than
            // leaving an iPad row that will never receive video.
            setState((s) => ({
              ...s,
              workspace: assignPanelDevice(s.workspace, panel.id, null),
              error: {
                code: 'capture-failed',
                message:
                  error instanceof Error ? error.message : 'Could not move that window to the iPad.',
                at: Date.now(),
              },
            }));
          });
          return;
        }

        if (event.kind === 'window.release') {
          const panelId = heldPanel.current;
          heldPanel.current = null;
          // Remember the id for the handoff that may follow this event.
          //
          // The main process emits `window.release` and then, in the same tick,
          // `window.handoff` when the release happened while looking at the iPad.
          // Clearing `heldPanel` above lost the window before the handoff could
          // read it, so the transfer silently did nothing.
          lastReleasedPanel.current = panelId;
          // The carry is over either way, so the card must go.
          setPreviewTitle(null);
          // Only a release we actually saw the *grab* for may move anything.
          //
          // Falling back to "whichever panel is selected" was how a window that
          // had already been sent to the iPad could be yanked back to the laptop
          // by the next open hand: the carry that ended on the tablet cleared
          // `heldPanel`, so a later release selected whatever panel was now
          // selected - the one that had just gone across.
          if (!panelId) return;
          const current = stateRef.current;
          const panel = current.workspace.panels.find((p) => p.id === panelId);
          if (!panel) return;

          const gaze = event.detail['gaze'];
          // Releasing toward the iPad sends the window there.
          //
          // Reported: "if i look at my iPad and release my fist, the window
          // transfer should take place."
          //
          // The main process emits a separate `window.handoff` for exactly this
          // case (it is the one that can see both the gaze and whether an iPad is
          // connected), so this branch only has to let go cleanly. Returning here
          // instead was the bug: the handoff arrived right after this event and
          // `heldPanel` had already been cleared, so nothing was ever sent.
          if (gaze === 'tablet') return;

          if (gaze === 'laptop') {
            // "Look at the screen and let go" is the put-it-back case. When the
            // panel already lives here this is deliberately a no-op, which is
            // exactly what the user expects.
            if (!panel.ownerDeviceId) return;
            void sendersRef.current.stop(panel.id);
            setState((s) => ({ ...s, workspace: assignPanelDevice(s.workspace, panel.id, null) }));
            return;
          }

          // No gaze reading is the ordinary case now: the window simply stays
          // where it was dragged on the laptop. Only complain when the gaze
          // system itself is misconfigured, since that is the one state the user
          // has to go and fix.
          if (event.detail['gazeMode'] === 'invalid') {
            setState((s) => ({
              ...s,
              error: {
                code: 'gaze',
                message:
                  'The saved gaze anchors cannot separate the screens. Record “Look at laptop” and “Look at iPad” again in Gestures.',
                at: Date.now(),
              },
            }));
          }
          return;
        }

        if (event.kind === 'pointer.press' || event.kind === 'pointer.release') {
          const x = Number(event.detail['x'] ?? NaN);
          const y = Number(event.detail['y'] ?? NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          const pressing = event.kind === 'pointer.press';
          // See the main process: the event carries the preference it acted on.
          const systemPointer =
            event.detail['systemPointer'] === undefined
              ? stateRef.current.systemPointer
              : event.detail['systemPointer'] === true;

          if (pressing) {
            // The service decides which screen the head is on at the instant of
            // the press. On the iPad the down is relayed to the receiver, where
            // the same hand cursor operates the shared panel and holds a drag.
            const detailGaze = event.detail['gaze'];
            const gaze = detailGaze === undefined ? gazeTarget.current : detailGaze;
            if (gaze === 'tablet') {
              tabletPressed.current = true;
              void api().pushPointer({ x, y, visible: true, target: 'tablet' }, 'down');
              return;
            }

            // With the system pointer on, the main process already pressed the
            // real Windows button. Pressing the DOM too would activate the
            // control twice.
            if (systemPointer) return;

            // Fallback (system pointer off): drive the in-app DOM so the finger
            // cursor still works like a mouse, including drags.
            const el = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
            if (!el) return;
            domPressed.current = el;
            const clientX = x * window.innerWidth;
            const clientY = y * window.innerHeight;
            el.dispatchEvent(
              new PointerEvent('pointerdown', {
                bubbles: true,
                clientX,
                clientY,
                button: 0,
                buttons: 1,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
              }),
            );
            el.dispatchEvent(
              new MouseEvent('mousedown', { bubbles: true, clientX, clientY, button: 0, buttons: 1 }),
            );
            return;
          }

          // A release belongs to whichever side received the down. If the gaze
          // moved mid-drag the iPad still owes the up; the laptop's real button
          // is released by the main process unconditionally.
          if (tabletPressed.current) {
            tabletPressed.current = false;
            void api().pushPointer({ x, y, visible: true, target: 'tablet' }, 'up');
            return;
          }
          if (systemPointer) return;

          const pressedEl = domPressed.current;
          domPressed.current = null;
          const clientX = x * window.innerWidth;
          const clientY = y * window.innerHeight;
          if (pressedEl) {
            pressedEl.dispatchEvent(
              new PointerEvent('pointerup', {
                bubbles: true,
                clientX,
                clientY,
                button: 0,
                buttons: 0,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
              }),
            );
            pressedEl.dispatchEvent(
              new MouseEvent('mouseup', { bubbles: true, clientX, clientY, button: 0, buttons: 0 }),
            );
          }

          const el = document.elementFromPoint(clientX, clientY);
          if (!el) return;
          const sameTarget = !pressedEl || pressedEl === el || pressedEl.contains(el) || el.contains(pressedEl);
          if (!sameTarget) return;
          const panelEl = el.closest('[data-panel-id]');
          const panelId = panelEl?.getAttribute('data-panel-id');
          if (panelId) {
            setState((s) => ({ ...s, workspace: selectPanel(s.workspace, panelId) }));
            return;
          }
          const actionable = el.closest('button, a, [role="button"], input, select, textarea');
          if (actionable instanceof HTMLElement) {
            actionable.focus();
            actionable.click();
          }
          return;
        }

        if (event.kind === 'pointer.click') {
          const x = Number(event.detail['x'] ?? NaN);
          const y = Number(event.detail['y'] ?? NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;

          // Legacy one-shot click. Kept so an older service build still works.
          const detailGaze = event.detail['gaze'];
          const gaze = detailGaze === undefined ? gazeTarget.current : detailGaze;
          if (gaze === 'tablet') {
            void api().pushPointer({ x, y, visible: true, target: 'tablet' }, 'click');
            return;
          }

          // The main process echoes the preference it acted on, exactly as it
          // does for press/release.
          const systemPointer =
            event.detail['systemPointer'] === undefined
              ? stateRef.current.systemPointer
              : event.detail['systemPointer'] === true;
          if (systemPointer) return;

          const el = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
          if (!el) return;
          const panelEl = el.closest('[data-panel-id]');
          const panelId = panelEl?.getAttribute('data-panel-id');
          if (panelId) {
            setState((s) => ({ ...s, workspace: selectPanel(s.workspace, panelId) }));
            return;
          }
          const actionable = el.closest('button, a, [role="button"], input, select, textarea');
          if (actionable instanceof HTMLElement) {
            actionable.focus();
            actionable.click();
          }
          return;
        }

        if (event.kind === 'window.throw') {
          // A fast pinch release is a *click*, not a window move. Throws used to
          // pick a destination by direction; now the gaze decides, so handling
          // this would move a panel as a side effect of clicking on the iPad.
          return;
        }
      }),
      // The window handle that was grabbed, resolved to a capture source.
      //
      // This is the only place a grabbed panel is created: the source is started
      // from here, so a stale resolution (the hand already let go) cannot create a
      // panel that was already released.
      on('orbit:ev-grab-target', (target) => {
        const startedAt = grabStartedAt.current;
        grabStartedAt.current = 0;
        // Remembered for the hand-off: the panel has to point at this exact
        // window on the laptop, not at whatever happens to be in front later.
        grabbedHwnd.current = target.hwnd;
        if (target.sourceId === null) {
          setState((s) => ({
            ...s,
            error: {
              code: 'capture-failed',
              message:
                'That window has no picture to capture. Bring the window you want in front, then raise your fist again.',
              at: Date.now(),
            },
          }));
          return;
        }
        if (startedAt !== 0 && Date.now() - startedAt > 5000) {
          // A reply for a grab the user abandoned minutes ago; ignore it rather
          // than dropping a window onto the workspace out of nowhere.
          return;
        }

        // Only a resolution that belongs to a fist still held is a carry. If the
        // hand opened before the source came back, the window is still added (the
        // user meant to pick it up) but nothing is marked as held, so a later
        // release cannot send a window the user is no longer holding.
        const stillHeld = startedAt !== 0;

        const current = stateRef.current;
        void ensureSession(target.sourceId);
        const existing = current.workspace.panels.find((p) => p.sourceId === target.sourceId);
        if (existing) {
          if (stillHeld) heldPanel.current = existing.id;
          setState((s) => ({ ...s, error: null, workspace: selectPanel(s.workspace, existing.id) }));
          return;
        }
        const { state: next, panel } = addPanel(current.workspace, {
          sourceId: target.sourceId,
          title: target.title || 'Window',
          kind: 'live',
        });
        // A fresh panel starts laptop-owned (no ownerDeviceId), which is what the
        // receiver uses to keep it off the iPad until it is sent.
        if (stillHeld) heldPanel.current = panel.id;
        else lastReleasedPanel.current = panel.id;
        setState((s) => ({ ...s, error: null, workspace: next }));
      }),

      // A left-fist swipe while looking at the iPad pages through the windows
      // that are already on it. The main process decides which meaning the swipe
      // has (desktops on the laptop, windows on the iPad) and tells us here.
      on('orbit:ev-cycle-panel', (direction) => {
        const current = stateRef.current;
        // Only windows that live on a receiver: the laptop's own panels are not
        // on the iPad, so paging through them would look like nothing happened.
        const onTablet = current.workspace.panels.filter((p) => p.ownerDeviceId);
        if (onTablet.length === 0) return;
        const index = onTablet.findIndex((p) => p.selected);
        const step = direction === 'left' ? -1 : 1;
        // Wrap around: a swipe past the last window goes back to the first, so
        // the gesture never dead-ends.
        const nextIndex = index === -1 ? 0 : (index + step + onTablet.length) % onTablet.length;
        const next = onTablet[nextIndex];
        if (!next) return;
        setState((s) => ({ ...s, workspace: selectPanel(s.workspace, next.id) }));
      }),

      // Relay the hand cursor to the receiver only while the head is turned to
      // the iPad. Looking at the laptop hides it, which is also what makes
      // "hands control the screen you are looking at" true on the receiver side.
      on('orbit:ev-gesture-status', (status) => {
        const gaze = status.gaze;
        const hasReceiver = (stateRef.current.session?.receivers?.length ?? 0) > 0;
        // Which screen the user is on.
        //
        // The laptop's own router is the wrong witness for this: the moment the
        // head turns to the iPad, the laptop's webcam loses the face and `gaze`
        // reports no target. The iPad's tracker is the one that can still see
        // the user, so its opinion is preferred while it is fresh, and the
        // laptop's reading is kept only as a fallback for a session with no
        // tablet tracking at all.
        const tabletReading = status.tabletGaze;
        const tabletFresh =
          Boolean(tabletReading) && Date.now() - Number(tabletReading?.at ?? 0) <= 2500;
        const tabletSaysTablet = tabletFresh && tabletReading?.looking === true;
        const tabletSaysLaptop = tabletFresh && tabletReading?.looking === false;
        const decided = tabletSaysTablet
          ? 'tablet'
          : tabletSaysLaptop
            ? 'laptop'
            : (gaze?.target ?? null);
        // With no iPad, everything stays local: turning the head toward where
        // an iPad would be must not hide the cursor or hand control on the only
        // screen that exists. The main process applies the same rule to clicks
        // and grabs.
        const target = hasReceiver ? decided : 'laptop';
        gazeTarget.current = target;

        // The preview exists only while a window is carried *and* the head is
        // turned toward the tablet.
        //
        // Reported: "when i look over at my iPad with something in my hand, it
        // should show a preview of the window I have and if i look away it should
        // disappear." Clearing it on every non-tablet frame is what makes looking
        // away dismiss it, and it is also the honest signal that no transfer will
        // happen if the user opens their hand now.
        const carriedId = heldPanel.current;
        if (carriedId && target === 'tablet' && hasReceiver) {
          const carried = stateRef.current.workspace.panels.find((p) => p.id === carriedId);
          setPreviewTitle(carried?.title ?? null);
        } else if (!carriedId) {
          setPreviewTitle(null);
        } else if (target !== 'tablet') {
          setPreviewTitle(null);
        }

        // The finger cursor lives on the screen the head is turned to. With no
        // calibration the laptop is the default, so raising a hand works before
        // the user has recorded the two gaze anchors. When the system pointer is
        // on, the real Windows cursor is already there, so the overlay would be
        // a second cursor on top of it.
        const onLaptop = target !== 'tablet';
        const laptopVisible = Boolean(
          status.armed &&
            !stateRef.current.systemPointer &&
            onLaptop &&
            status.handVisible &&
            status.pointer,
        );
        setHandCursor(
          laptopVisible && status.pointer ? { x: status.pointer[0], y: status.pointer[1] } : null,
        );

        const visible = Boolean(
          status.armed && target === 'tablet' && status.handVisible && status.pointer,
        );
        const now = Date.now();
        const last = lastPointer.current;
        // Always send a visibility change; otherwise cap the cursor stream at
        // roughly 30fps so a stationary hand does not flood the socket.
        if (now - last.at < 30 && visible === last.visible) return;

        const x = status.pointer?.[0] ?? last.x;
        const y = status.pointer?.[1] ?? last.y;
        lastPointer.current = { visible, x, y, at: now };
        void api().pushPointer({ x, y, visible, target: visible ? 'tablet' : null });
      }),
      on('orbit:ev-panel-close', (panelId) => {
        void sendersRef.current.stop(panelId);
        setState((s) => ({ ...s, workspace: removePanel(s.workspace, panelId) }));
      }),
      on('orbit:ev-panel-return', (panelId) => {
        void sendersRef.current.stop(panelId);
        setState((s) => ({ ...s, workspace: removePanel(s.workspace, panelId) }));
      }),
      on('orbit:ev-panel-move', (panelId, rect) => {
        setState((s) => ({ ...s, workspace: movePanel(s.workspace, panelId, rect as PanelRect) }));
      }),
      on('orbit:ev-mode-set', (mode) => {
        setState((s) => ({ ...s, workspace: setMode(s.workspace, mode as InteractionMode) }));
      }),
      on('orbit:ev-stop', () => {
        void sendersRef.current.stopAll();
        setState((s) => ({ ...s, workspace: emptyWorkspace(), streaming: false, task: null }));
      }),
      // The receiver has no broadcast button of its own: a window reaches it
      // only through a gaze-directed release, and leaves the same way.
      on('orbit:ev-approval-response', () => {
        setState((s) => ({ ...s, approval: null }));
      }),
      on('orbit:ev-error', (code, message) => {
        setState((s) => ({ ...s, error: { code: String(code), message: String(message), at: Date.now() } }));
      }),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the shared workspace in sync with the receivers.
  //
  // The carried-window preview rides along with it. Reported: "when i look over
  // at my iPad with something in my hand, it should show a preview of the window
  // I have and if I look away it should disappear." The receiver has no other
  // view of a window that has not been sent yet, so the title travels with the
  // workspace it is about to join.
  useEffect(() => {
    if (!state.session || state.session.phase === 'idle') return;
    void api().pushWorkspace(
      previewTitle === null ? state.workspace : { ...state.workspace, preview: { title: previewTitle } },
    );
  }, [state.workspace, state.session, previewTitle]);

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------
  const refreshSources = useCallback(async () => {
    const list = await api().requestSources({ thumbnails: true });
    setState((s) => ({
      ...s,
      sources: list,
      activeSourceId:
        s.activeSourceId && list.some((x: WindowSource) => x.id === s.activeSourceId)
          ? s.activeSourceId
          : (list[0]?.id ?? null),
    }));
    return list;
  }, []);



  const stopSession = useCallback(async () => {
    await senders.stopAll();
    await api().stopSession();
    heldPanel.current = null;
    setState((s) => ({ ...s, streaming: false, workspace: emptyWorkspace(), session: null }));
  }, [senders]);

  // Choosing another window swaps what the iPad is showing. Only a panel of the
  // previous source is replaced; anything the user arranged stays put.
  //
  // There is deliberately no automatic share on connect any more: picking a
  // window and grabbing it is the action that sends it anywhere.
  const setActiveSource = useCallback(async (sourceId: string) => {
    const current = stateRef.current;
    await api().setActiveSource(sourceId);
    const previousSource = current.activeSourceId;
    const replaced = previousSource
      ? current.workspace.panels.filter((p) => p.sourceId === previousSource)
      : [];
    heldPanel.current = null;
    setState((s) => ({
      ...s,
      activeSourceId: sourceId,
      workspace: {
        ...s.workspace,
        panels: s.workspace.panels.filter((p) => p.sourceId !== previousSource),
      },
    }));
    await Promise.all(replaced.map((p) => sendersRef.current.stop(p.id)));
  }, []);

  const returnPanel = useCallback(
    async (panelId: string) => {
      await senders.stop(panelId);
      setState((s) => ({ ...s, workspace: removePanel(s.workspace, panelId) }));
    },
    [senders],
  );

  // Keyboard shortcuts on the desktop side.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key.toLowerCase() === 'r' && stateRef.current.streaming) {
        event.preventDefault();
        const selected = stateRef.current.workspace.panels.find((p) => p.selected);
        if (selected) void returnPanel(selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [returnPanel]);

  // The camera runs for the whole life of the app, not only while an iPad is
  // connected. Gesture *detection* is useful on its own — the Gestures tab is a
  // live preview of what the detector sees — so tying it to a receiver would
  // make the preview dead exactly when someone is trying to debug it. Arming is
  // separate: an unarmed machine still reports landmarks and a phase but never
  // acts on them.
  const [camera, setCamera] = useState<'starting' | 'live' | 'off' | 'failed'>('off');
  const cameraStarted = useRef(false);
  useEffect(() => {
    if (cameraStarted.current) return;
    cameraStarted.current = true;
    // Starting the service is all this does. Arming is owned by the main
    // process, which consults the live `gestureArmedByDefault` preference on
    // every `running` transition. Re-arming from a value read here would undo a
    // deliberate disarm the moment the camera restarted.
    void (async () => {
      const current = await api().gestureState();
      // Already running (a previous window): the main process already made the
      // arming decision when it reached this state.
      if (current.state === 'running') {
        setCamera('live');
        return;
      }
      setCamera('starting');
      const result = await api().gestureStart();
      if (!result.ok) {
        cameraStarted.current = false;
        setCamera('failed');
        setState((s) => ({ ...s, error: { code: 'camera', message: result.message, at: Date.now() } }));
      }
    })().catch(() => setCamera('failed'));
  }, []);

  useEffect(() => {
    const off = on('orbit:ev-gesture-state', ({ state, error }) => {
      if (state === 'running') {
        setCamera('live');
        // Arming is owned by the main process, which consults the live
        // `gestureArmedByDefault` preference. Do not re-arm here: a stale
        // startup value would undo a disarm the moment the camera restarted.
      } else if (state === 'starting') setCamera('starting');
      else if (state === 'failed') {
        setCamera('failed');
        // Surface the service's own reason. The Gestures page can only say
        // "the camera could not start"; without this the user never sees the
        // actual cause (missing Python package, port conflict, real device
        // conflict) and reasonably assumes it is blaming another app.
        if (error) {
          setState((s) =>
            s.error?.message === error
              ? s
              : { ...s, error: { code: 'camera', message: error, at: Date.now() } },
          );
        }
      } else setCamera('off');
    });
    return off;
  }, []);

  const shared: SharedProps = {
    state,
    setState,
    refreshSources,
    stopSession,
    setActiveSource,
    returnPanel,
    camera,
  };

  return (
    <div className="app">
      <Sidebar
        page={page}
        onNavigate={setPage}
        link={state.link}
        streaming={state.streaming}
        camera={camera}
      />
      <main className="page">
        {state.error && Date.now() - state.error.at < 60_000 ? (
          <div className={`banner${state.error.code === 'protocol' || state.error.code === 'gaze' ? '' : ' bad'}`}>
            <span>{state.error.message}</span>
            <button
              className="btn btn-sm btn-ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => setState((s) => ({ ...s, error: null }))}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {page === 'setup' && <SetupPage {...shared} />}
        {page === 'workspace' && <WorkspacePage {...shared} />}
        {page === 'gestures' && <GesturesPage {...shared} />}
      </main>

      {/* Second pointer: driven by the hand, not the mouse. It only appears when
          a hand is visible and the head is not turned to the iPad. */}
      {handCursor ? (
        <div
          className="hand-cursor"
          style={{ left: `${handCursor.x * 100}%`, top: `${handCursor.y * 100}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

export interface SharedProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  refreshSources: () => Promise<WindowSource[]>;
  stopSession: () => Promise<void>;
  setActiveSource: (sourceId: string) => Promise<void>;
  returnPanel: (panelId: string) => Promise<void>;
  /** Real gesture-service state, independent of whether an iPad is connected. */
  camera: 'starting' | 'live' | 'off' | 'failed';
}
