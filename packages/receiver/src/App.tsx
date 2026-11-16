import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRequest, InteractionMode, PanelRect, TaskState, TranscriptEvent } from '@orbit/shared';
import { useOrbitLink } from './lib/link.js';
import { useStreams } from './lib/streams.js';
import { useTabletTracking } from './lib/tablet-tracking.js';
import { PairingScreen } from './components/PairingScreen.js';
import { StandbyScreen } from './components/StandbyScreen.js';
import { Workspace, type LiveOverlays } from './components/Workspace.js';

export function App() {
  const link = useOrbitLink();
  const { streams, handleOffer, addIce, closePanel } = useStreams(link.send);

  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [transcript, setTranscript] = useState<TranscriptEvent | null>(null);
  const [task, setTask] = useState<TaskState | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  /**
   * The hand cursor, positioned directly in the DOM.
   *
   * Not React state: this is written at camera frame rate (about 24 times a
   * second), and re-rendering the workspace that often on an iPad is exactly
   * the main-thread work that made the cursor lag behind the hand. Two writers
   * share it — the iPad's own tracker, and the laptop's relayed pointer when
   * local tracking has no opinion — and they agree because each checks whether
   * the other owns the screen before writing.
   */
  const cursorEl = useRef<HTMLDivElement | null>(null);
  const setCursor = useCallback((x: number | null, y?: number) => {
    const el = cursorEl.current;
    if (!el) return;
    if (x === null || y === undefined) {
      el.style.opacity = '0';
      return;
    }
    // `translate3d` keeps this on the compositor; the trailing translate centres
    // the dot on the point rather than putting its top-left corner there.
    el.style.opacity = '1';
    el.style.transform = `translate3d(${(x * window.innerWidth).toFixed(1)}px, ${(y * window.innerHeight).toFixed(1)}px, 0) translate(-50%, -50%)`;
  }, []);
  /** Element the relayed pinch pressed, so the up finishes on the same target. */
  const downTarget = useRef<Element | null>(null);

  const activate = useCallback(
    (x: number, y: number) => {
      const target = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
      if (!target) return;
      const panelId = target.closest('[data-panel-id]')?.getAttribute('data-panel-id');
      if (panelId) {
        void link.send({ t: 'receiver.panel.select', panelId });
        return;
      }
      const actionable = target.closest('button, a, [role="button"], input, select, textarea');
      if (actionable instanceof HTMLElement) {
        actionable.focus();
        actionable.click();
      }
    },
    [link],
  );

  /**
   * Local camera tracking. This is the iPad's own hand and face detection, not
   * a relay of the laptop's: it is what lets the iPad keep working when the
   * user turns away from the laptop's webcam.
   */
  const localDownTarget = useRef<Element | null>(null);
  const localDown = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
    localDownTarget.current = el;
    if (!el) return;
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
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY, button: 0, buttons: 1 }));
  }, []);
  const localUp = useCallback(
    (x: number, y: number) => {
      const pressedEl = localDownTarget.current;
      localDownTarget.current = null;
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
      const sameTarget = !pressedEl || !el || pressedEl === el || pressedEl.contains(el) || el.contains(pressedEl);
      if (sameTarget) activate(x, y);
    },
    [activate],
  );
  const tracker = useTabletTracking({
    onDown: localDown,
    onUp: localUp,
    onPointer: (position) => setCursor(position ? position.x : null, position?.y),
    onGaze: (looking) => {
      // Only a small opinion crosses the wire; the camera frames never do.
      void link.send({ t: 'receiver.gaze', looking, at: Date.now() });
    },
    onFist: (fist) => {
      // The laptop cannot see the hand once the head has turned to this iPad, so
      // this is its only report of the moment the carry gesture finishes.
      void link.send({ t: 'receiver.fist', fist, at: Date.now() });
    },
  });

  /**
   * True while the iPad is doing its own tracking.
   *
   * Both cameras can see the same hand when the user is between screens. In the
   * moment the local tracker owns the screen, the relayed laptop pointer must be
   * ignored: acting on both would press, drag and click twice for one pinch.
   * The ref is updated every render so the link handlers, which are installed
   * once, see the current value.
   */
  const localTrackingRef = useRef(false);
  localTrackingRef.current = tracker.state === 'running';

  // A camera must never stay on for an iPad that is no longer paired: this
  // screen may be left on a desk, and the local tracker's only purpose is
  // driving a session that has gone away. The stop callback is recreated each
  // render, so keep it in a ref and only react to the link state.
  const trackerStopRef = useRef(tracker.stop);
  trackerStopRef.current = tracker.stop;
  const linked =
    link.state === 'paired' || link.state === 'reconnecting' || Boolean(link.session);
  useEffect(() => {
    if (!linked && tracker.state !== 'off') trackerStopRef.current();
  }, [linked, tracker.state]);

  // Wire signalling callbacks once; the hook stores them in a ref internally.
  const offerRef = useRef(handleOffer);
  offerRef.current = handleOffer;
  const iceRef = useRef(addIce);
  iceRef.current = addIce;
  const closeRef = useRef(closePanel);
  closeRef.current = closePanel;

  useEffect(() => {
    link.setHandlers({
      onOffer: (msg) => void offerRef.current(msg.panelId, msg.offer.sdp),
      onIce: (msg) => void iceRef.current(msg.panelId, msg.candidate),
      onStreamStop: (panelId) => closeRef.current(panelId),
      onTask: (msg) => setTask(msg.task),
      onApproval: (msg) => setApproval(msg.approval),
      onTranscript: (msg) => setTranscript(msg.transcript),
      onVoiceState: (state) => setVoiceState(state),
      onPointer: (next) => {
        if (localTrackingRef.current) return;
        setCursor(next.visible ? next.x : null, next.visible ? next.y : undefined);
      },
      onPointerClick: (next) => {
        if (localTrackingRef.current) return;
        if (!next.visible) return;
        // The cursor is drawn at these viewport coordinates, so selecting the
        // element under them is exactly "pinch what the cursor is over". Panels
        // are selected through the shared workspace; buttons and controls are
        // activated directly so the iPad cursor is not limited to panels.
        activate(next.x, next.y);
      },
      onPointerDown: (next) => {
        if (localTrackingRef.current) return;
        setCursor(next.visible ? next.x : null, next.visible ? next.y : undefined);
        if (!next.visible) return;
        const el = document.elementFromPoint(next.x * window.innerWidth, next.y * window.innerHeight);
        downTarget.current = el;
        if (!el) return;
        const clientX = next.x * window.innerWidth;
        const clientY = next.y * window.innerHeight;
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
      },
      onPointerUp: (next) => {
        // Finish a relayed drag that was already down, but ignore an up for a
        // down this iPad never accepted because local tracking owned it.
        if (localTrackingRef.current && !downTarget.current) return;
        setCursor(next.visible ? next.x : null, next.visible ? next.y : undefined);
        const pressedEl = downTarget.current;
        downTarget.current = null;
        const clientX = next.x * window.innerWidth;
        const clientY = next.y * window.innerHeight;
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
        if (!next.visible) return;
        const el = document.elementFromPoint(clientX, clientY);
        const sameTarget = !pressedEl || !el || pressedEl === el || pressedEl.contains(el) || el.contains(pressedEl);
        if (sameTarget) activate(next.x, next.y);
      },
      onSession: (session) => {
        if (session.phase === 'ended') {
          setTask(null);
          setApproval(null);
          setTranscript(null);
          setVoiceState('idle');
          setCursor(null);
        }
      },
    });
  }, [link]);

  // A dropped link must not leave the hand cursor frozen on screen.
  useEffect(() => {
    if (link.state !== 'paired') setCursor(null);
  }, [link.state, setCursor]);

  // Approvals expire; never leave a stale Accept button on screen.
  useEffect(() => {
    if (!approval) return;
    const remaining = approval.expiresAt - Date.now();
    if (remaining <= 0) {
      setApproval(null);
      return;
    }
    const timer = window.setTimeout(() => setApproval(null), remaining);
    return () => window.clearTimeout(timer);
  }, [approval]);

  const overlays: LiveOverlays = useMemo(
    () => ({ voiceState, transcript, task, approval }),
    [voiceState, transcript, task, approval],
  );

  const send = link.send;
  const join = link.join;

  // Stable identity so the pairing screen's submit handler (which is a prop of
  // a memoised-free subtree) does not get a fresh function on every render.
  const onJoin = useCallback((code: string) => void join(code), [join]);

  const onMove = useCallback(
    (panelId: string, rect: PanelRect) => send({ t: 'receiver.panel.move', panelId, rect }),
    [send],
  );
  const onSelect = useCallback(
    (panelId: string) => send({ t: 'receiver.panel.select', panelId }),
    [send],
  );
  const onClose = useCallback(
    (panelId: string) => {
      send({ t: 'receiver.panel.close', panelId });
      closePanel(panelId);
    },
    [closePanel, send],
  );
  const onReturn = useCallback(
    (panelId: string) => {
      send({ t: 'receiver.panel.return', panelId });
      closePanel(panelId);
    },
    [closePanel, send],
  );
  const onMode = useCallback(
    (mode: InteractionMode) => send({ t: 'receiver.mode.set', mode }),
    [send],
  );

  const onStop = useCallback(() => {
    send({ t: 'receiver.stop' });
    setTask(null);
    setApproval(null);
    setTranscript(null);
    setVoiceState('idle');
  }, [send]);
  // The only command that is still reachable from this screen is the local
  // "stop the current task" action. There is no manual broadcast or free-text
  // command entry any more.
  const onCommand = useCallback(
    (text: string) => {
      if (text === '__dismiss') {
        setTask(null);
        return;
      }
      send({ t: 'receiver.stop' });
    },
    [send],
  );
  const onApproval = useCallback(
    (approvalId: string, accept: boolean) => {
      send({ t: 'receiver.approval', approvalId, accept });
      setApproval(null);
    },
    [send],
  );
  const onDismissApproval = useCallback(() => setApproval(null), []);

  // Keyboard/pointer affordance for the command sheet, so the fallback exists
  // even before gesture control ships.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setApproval(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Desktop-owned panels (no ownerDeviceId) live on the laptop and must not
  // appear here. This is what lets a grab stay local until the head turns.
  const myPanels = useMemo(
    () => (link.workspace?.panels ?? []).filter((panel) => panel.ownerDeviceId === link.device.id),
    [link.workspace, link.device.id],
  );
  const deviceWorkspace = useMemo(
    () => (link.workspace ? { ...link.workspace, panels: myPanels } : null),
    [link.workspace, myPanels],
  );

  if (
    link.state === 'unpaired' ||
    link.state === 'pairing' ||
    (link.state !== 'paired' && link.state !== 'reconnecting' && !link.session)
  ) {
    return (
      <PairingScreen
        state={link.state}
        error={link.lastError}
        rejections={link.pairingRejections}
        onSubmit={onJoin}
        initialCode={link.bootCode}
        onReconnect={link.reconnect}
      />
    );
  }

  // 'reconnecting' on a cold start means the stored device id is being offered
  // to the laptop without a code. Show the clock (with a reconnecting status)
  // instead of a six-digit screen the user has no code for.

  // A paired iPad with nothing to show is the resting state, not an error: a
  // clock reads as "alive and waiting" where an empty canvas read as a hang.
  // Task and approval overlays still take priority — they are the reason the
  // user is looking at the iPad in the first place.
  const idle = myPanels.length === 0 && !task && !approval && voiceState === 'idle';

  // A window being carried toward this iPad, shown while the user looks here.
  //
  // Reported: "when i look over at my iPad with something in my hand, it should
  // show a preview of the window I have and if i look away it should disappear."
  // The desktop publishes this only while the head is on this screen and a grab
  // is held, so it vanishes by itself when the user looks away - no timer, and no
  // chance of a stale card suggesting a transfer is still pending.
  const carried = link.workspace?.preview ?? null;

  return (
    <>
      {idle ? (
        <>
          <StandbyScreen state={link.state} session={link.session} />
          {carried ? (
            <div className="carried-preview" role="status">
              <span className="carried-label">Release to send</span>
              <span className="carried-title">{carried.title}</span>
            </div>
          ) : null}
        </>
      ) : (
        <Workspace
          state={link.state}
          session={link.session}
          sources={link.sources}
          workspace={deviceWorkspace}
          streams={streams}
          overlays={overlays}
          onMove={onMove}
          onSelect={onSelect}
          onClose={onClose}
          onReturn={onReturn}
          onMode={onMode}
          onStop={onStop}
          onCommand={onCommand}
          onApproval={onApproval}
          onDismissApproval={onDismissApproval}
        />
      )}

      {/* Always mounted: its transform is written from the tracking loop. */}
      <div ref={cursorEl} className="hand-cursor" aria-hidden="true" />

      {/*
        The camera only starts from a real tap: Safari refuses getUserMedia from
        anything that is not a user gesture, and the model load is too slow to
        follow one automatically. The chip doubles as the explanation of why the
        hand cursor is or is not moving.
      */}
      {/*
        No button.
        
        Reported: "Why is there still a separate enable hand tracking button",
        and the same chip was showing up on the standby screen beside the clock.

        Tracking now starts by itself: automatically on mount when camera
        permission is already granted, and otherwise on the first touch anywhere
        on this screen. A button was left over from the old opt-in flow and only
        added friction — the user is about to control this screen with their
        hand, so making them aim at a small target first defeats the point.

        The chip is now purely informational: it says what the tracker is doing
        and, when Safari has refused the camera, what to tap. The tap itself is
        handled by the global listener in tablet-tracking, so it does not need a
        dedicated control.
      */}
      <div className={`tracking-chip tracking-${tracker.state}`} role="status">
        {tracker.state === 'off' ? (
          <span className="tracking-note">Tap anywhere to start hand tracking</span>
        ) : tracker.state === 'starting' ? (
          <span className="tracking-note">Starting camera…</span>
        ) : tracker.state === 'failed' ? (
          <span className="tracking-note">
            {tracker.error ?? 'Camera failed.'} Tap anywhere to try again.
          </span>
        ) : (
          <>
            <span
              className={`tracking-dot ${tracker.looking === true ? 'is-looking' : ''}`}
              aria-hidden="true"
            />
            <span className="tracking-note">
              {tracker.looking === true
                ? 'Tracking your hand'
                : tracker.looking === false
                  ? 'Turned away — look here to control'
                  : 'Show your face to take over'}
            </span>
          </>
        )}
      </div>
    </>
  );
}
