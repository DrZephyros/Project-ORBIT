import { ipcMain, screen, session, shell, type BrowserWindow, type desktopCapturer as desktopCapturerModule } from 'electron';
import QRCode from 'qrcode';
import type { HandPointer, SourceCatalog, WorkspaceState } from '@orbit/shared';
import type { OrbitClient } from './client.js';
import type { Settings } from './settings.js';
import type { GestureBridge, PointerFrameMessage } from './gestures.js';
import type { SystemPointer } from './system-pointer.js';
import { log, logDirectory, logFile } from './log.js';
import { EV, IPC, type OrbitPrefs, type OrbitStatus } from '../shared/ipc.js';

interface Deps {
  client: OrbitClient;
  settings: Settings;
  getWindow: () => BrowserWindow | null;
  desktopCapturer: typeof desktopCapturerModule;
  gestures: GestureBridge;
  systemPointer: SystemPointer;
}

/** Source ids the renderer is allowed to capture, one at a time. */
let captureGrant: { sourceId: string; issuedAt: number; used: boolean } | null = null;
const GRANT_TTL_MS = 30_000;

/**
 * How far a grabbed window steps toward its target each pointer frame (0..1).
 *
 * 0.35 keeps up with a deliberate hand sweep while still smearing out the
 * per-frame landmark jitter that made the window judder. 1.0 would be raw
 * following (abrupt); much lower and the window lags visibly behind the hand.
 */
const WINDOW_DRAG_EASING = 0.35;

export function registerIpc({ client, settings, getWindow, desktopCapturer, gestures, systemPointer }: Deps): void {
  const emit = (channel: string, ...args: unknown[]): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  // Last hand position, used when a click event arrives without coordinates.
  // Normalised [0,1] against the display that contains the ORBIT window.
  const lastPointer = { x: 0.5, y: 0.5, gaze: null as 'laptop' | 'tablet' | null };

  /**
   * True while the Windows left button is held down by a pinch.
   *
   * This is deliberately separate from the Python machine's own `_pressed`: the
   * main process can release the OS button on its own (gaze moves to the iPad,
   * the service stops), and the two must not disagree about whether an up is
   * still owed.
   */
  let osPressed = false;
  /** Which device owned the gesture when the current window grab started. */
  let grabOwner: 'laptop' | 'tablet' = 'laptop';
  /**
   * True while the user is *carrying* a window, i.e. a fist grab is held.
   *
   * Deliberately separate from `windowDrag`, which is the physical Win32 move of
   * the window and only exists while the head is on the laptop. Turning to the
   * iPad ends the physical drag - the window must not follow the hand to a
   * screen it is not on - but it must not end the *carry*: the carry is the
   * thing the user is about to confirm. Only a real release ends it.
   */
  let grabHeld = false;
  /** When the carry started, so a lost hand cannot leave a window carried forever. */
  let grabHeldAt = 0;
  /** How long a half-finished carry is kept before it is forgotten. */
  const CARRY_TIMEOUT_MS = 30_000;
  /**
   * The iPad's report of whether the hand in front of it is a fist, and when.
   *
   * `null` until it has said anything. The laptop cannot answer this question
   * while the user is looking at the tablet, so the tablet's own camera is the
   * only witness to the moment the hand opens. Kept for the Gestures page and
   * for a log line that says why a carry did or did not finish.
   */
  let tabletFist: boolean | null = null;
  let tabletFistAt = 0;
  /** The single in-flight desktop repin chain, cancelled when a new one starts. */
  let repinTimer: NodeJS.Timeout | null = null;
  /** Where the current dictation should end up: a focused field, or the clipboard. */
  let dictationTarget: 'field' | 'clipboard' | null = null;
  /**
   * The real OS window a fist is currently moving, plus the hand position the
   * grab started at. Deltas are measured from that origin, so the window follows
   * the hand instead of snapping to it.
   */
  let windowDrag: {
    left: number;
    top: number;
    screenWidth: number;
    screenHeight: number;
    grabX: number;
    grabY: number;
    /** Eased position actually sent to the helper; `null` until the first frame. */
    smoothX: number | null;
    smoothY: number | null;
    /** Screen bounds in DIP, so the window can be kept on the laptop. */
    screenLeft: number;
    screenTop: number;
    /** Set once the window has been pushed past the edge to hand to the iPad. */
    handedOff: boolean;
  } | null = null;
  /** Invalidates an in-flight `grabWindow` when the grab is cancelled. */
  let windowGrabToken = 0;
  /**
   * The iPad's own face tracker. A `null` / stale reading means "no opinion";
   * the laptop's gaze router stays authoritative in that case.
   */
  let tabletGaze: { looking: boolean | null; at: number } = { looking: null, at: 0 };
  const TABLET_GAZE_TTL_MS = 2500;

  const tabletGazeFresh = (): boolean =>
    tabletGaze.looking !== null && Date.now() - tabletGaze.at <= TABLET_GAZE_TTL_MS;

  /**
   * True when a paired iPad is actually connected.
   *
   * Mouse control must never depend on one. Without a receiver, a gaze that
   * happens to point at where the iPad would sit must not swallow a pinch or a
   * grab: both stay on the laptop, which is the only screen that exists.
   */
  const receiverConnected = (): boolean => (client.session?.receivers?.length ?? 0) > 0;

  const currentOwner = (): 'laptop' | 'tablet' => {
    if (!receiverConnected()) return 'laptop';
    if (tabletGazeFresh()) return tabletGaze.looking ? 'tablet' : 'laptop';
    return lastPointer.gaze === 'tablet' ? 'tablet' : 'laptop';
  };

  /**
   * Decide which screen a gesture belongs to.
   *
   * The iPad's own tracker wins while it has a live opinion, then the gaze the
   * Python service attached to the event, then the last pointer frame. An
   * explicit `null` is "no decision" and stays local; only a missing field
   * falls back to the last frame.
   */
  const resolveGaze = (detailGaze: unknown): 'laptop' | 'tablet' => {
    const decided: 'laptop' | 'tablet' = tabletGazeFresh()
      ? tabletGaze.looking
        ? 'tablet'
        : 'laptop'
      : detailGaze === 'tablet'
        ? 'tablet'
        : detailGaze === 'laptop'
          ? 'laptop'
          : detailGaze === null
            ? 'laptop'
            : lastPointer.gaze === 'tablet'
              ? 'tablet'
              : 'laptop';
    return decided === 'tablet' && !receiverConnected() ? 'laptop' : decided;
  };

  const releaseOsPointer = (): void => {
    if (!osPressed) return;
    osPressed = false;
    systemPointer.release();
  };

  /**
   * Stop physically moving a grabbed window.
   *
   * Incrementing the token first also cancels a grab whose helper reply has not
   * arrived yet, so a late answer cannot start a drag the user already released.
   */
  const endWindowDrag = (): void => {
    windowGrabToken += 1;
    if (!windowDrag) return;
    windowDrag = null;
    systemPointer.endWindowMove();
  };

  /**
   * Finish a carry by sending the held window to the iPad.
   *
   * Two things can finish it, and both are the same intent:
   *
   *  * the laptop camera sees the fist open while the head is still on the
   *    laptop (`via: 'release'`), and
   *  * the iPad camera sees it open after the head has turned to the iPad
   *    (`via: 'tablet-fist'`).
   *
   * The second one is not a fallback: it is the normal path. By the time the
   * user is looking at the iPad the laptop's webcam is pointed at the side or
   * back of their head, so it usually cannot see the hand, and cannot see the
   * face it needs before it will process a gesture at all. Requiring the laptop
   * to witness the release is why the transfer only sometimes happened.
   *
   * `grabHeld` is cleared here rather than in the caller, so the two paths cannot
   * both fire for one carry.
   */
  const handOffToTablet = (via: 'release' | 'tablet-fist'): boolean => {
    if (!grabHeld) return false;
    if (!receiverConnected()) return false;
    grabHeld = false;
    grabHeldAt = 0;
    endWindowDrag();
    log.info('ipc', 'Window handed to the iPad.', { via });
    emit(EV.gestureEvent, {
      type: 'gesture',
      kind: 'window.handoff',
      detail: { direction: 'gaze', gaze: 'tablet', via },
    });
    return true;
  };

  /**
   * Ask the helper for the window a fist should move. The foreground window is
   * the target; when ORBIT is focused (which is where the Gestures page lives)
   * the helper falls back to the topmost other window, skipping ORBIT's own PID.
   */
  /**
   * Re-pin ORBIT's window onto the desktop that is now current.
   *
   * The switch is animated by the shell, so the new desktop is not current the
   * instant `switchDesktop` returns. Polling briefly is more reliable than one
   * delayed attempt, and it stops as soon as the helper reports success.
   */
  const scheduleRepin = (): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // `getNativeWindowHandle` is a little-endian buffer of the HWND.
    const handle = win.getNativeWindowHandle();
    if (handle.length < 4) return;
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    if (hwnd === 0n) return;

    // Only one repin chain at a time.
    //
    // Reported: "it just crashes a lot."
    //
    // Every desktop switch started its own chain of six timers, and each tick
    // asked the helper to create a COM VirtualDesktopManager to answer which
    // desktop is current. A sweep that switched several desktops in a row
    // therefore had dozens of overlapping chains, each spawning COM objects
    // against a desktop the shell was still animating. Cancelling the previous
    // chain means the newest position always wins and at most one chain exists.
    if (repinTimer !== null) {
      clearTimeout(repinTimer);
      repinTimer = null;
    }

    let tries = 0;
    const attempt = (): void => {
      tries += 1;
      systemPointer.pinToCurrentDesktop(hwnd);
      // The shell animates the switch; keep re-pinning briefly so the window
      // lands on the desktop that is finally current.
      if (tries < 6) {
        repinTimer = setTimeout(attempt, 120);
      } else {
        repinTimer = null;
      }
    };
    attempt();
  };

  const beginWindowDrag = (): void => {
    if (!settings.prefs.systemPointer) return;
    // Capture the hand position now: the helper reply arrives a few frames
    // later, and using the position at reply time would jump the window.
    const grabX = lastPointer.x;
    const grabY = lastPointer.y;
    const token = ++windowGrabToken;
    void systemPointer.grabWindow(process.pid).then((target) => {
      if (token !== windowGrabToken) return;
      if (!target) {
        log.warn('ipc', 'Grab found no window to move.');
        emit(EV.error, 'gesture', 'No window to move. Focus a window, then raise your fist again.');
        return;
      }
      log.info('ipc', 'Grabbed a window.', target);
      const win = getWindow();
      const display =
        win && !win.isDestroyed()
          ? screen.getDisplayMatching(win.getBounds())
          : screen.getPrimaryDisplay();
      windowDrag = {
        left: target.left,
        top: target.top,
        screenWidth: display.bounds.width,
        screenHeight: display.bounds.height,
        grabX,
        grabY,
        smoothX: null,
        smoothY: null,
        screenLeft: display.bounds.x,
        screenTop: display.bounds.y,
        handedOff: false,
      };
    });
  };

  /**
   * Map a normalised hand position onto the coordinate space `SetCursorPos` uses.
   *
   * The hand coords are fractions of the screen the user is facing, which is the
   * one ORBIT is on.
   *
   * These must be *DIP* (logical) pixels, not physical ones. `dipToScreenPoint`
   * returns physical pixels, and `SetCursorPos` on a DPI-unaware process — which
   * the PowerShell helper is — interprets its arguments in the virtualised
   * logical space. At 125% scaling those differ by 1.25x: asking for the physical
   * (1875, 1000) put the OS cursor at (1500, 800), and a click aimed at the
   * bottom-right landed off-screen and hit nothing.
   *
   * `display.bounds` is already in DIPs and is the same space the helper sees
   * (measured: 1536x864 on a 1920x1080 display at 125%), so it needs no
   * conversion at all.
   */
  const toScreenPoint = (x: number, y: number): { x: number; y: number } => {
    const win = getWindow();
    // The *primary* display, not the one ORBIT happens to be on.
    //
    // Reported: "whenever i try clicking on the taskbar to open an app it
    // doesn't work. I can see it clicking but it doesn't open."
    //
    // The taskbar lives at the edge of the primary display. Mapping the hand
    // onto whichever display held the ORBIT window meant that on a multi-monitor
    // machine - or with ORBIT restored onto a different screen - a hand at the
    // bottom of the frame resolved to the bottom of *that* screen, which has no
    // taskbar on it. The click was real, it just landed on empty desktop.
    //
    // `bounds` is deliberately used rather than `workArea`: the work area stops
    // above the taskbar, so clamping to it made the taskbar itself unreachable
    // even on a single monitor.
    const display = screen.getPrimaryDisplay();
    const bounds = display.bounds;
    const cx = Math.min(1, Math.max(0, x));
    const cy = Math.min(1, Math.max(0, y));
    return {
      x: Math.round(bounds.x + cx * bounds.width),
      y: Math.round(bounds.y + cy * bounds.height),
    };
  };

  const status = (): OrbitStatus => ({
    link: linkState,
    desktop: client.device,
    session: client.session,
    pairing: client.pairing,
    receivers: client.session?.receivers ?? [],
    lastError: lastError,
    sources: [],
  });

  let linkState: OrbitStatus['link'] = 'connecting';
  let lastError: OrbitStatus['lastError'] = null;

  client.on('status', (state: OrbitStatus['link']) => {
    linkState = state;
    emit(EV.status, status());
  });

  client.on('tabletGaze', (looking: boolean | null) => {
    // Timestamp on receipt, not from the iPad's clock: a tablet whose clock is
    // minutes ahead would otherwise look "fresh" forever and keep control after
    // it had gone away. The wire `at` is only a diagnostic.
    tabletGaze = { looking, at: Date.now() };
    // The iPad taking over is the moment the laptop must let go of the mouse.
    // A held drag that crossed screens would otherwise continue invisibly on
    // the laptop while the user is looking at the iPad.
    //
    // It must *not* let go of the carry. `endWindowDrag` stops the physical
    // Win32 move; `grabHeld` is what says "a window is still in the user's
    // hand", and the whole transfer gesture depends on it surviving the head
    // turn. Clearing it here meant looking at the iPad cancelled the very thing
    // the user was about to complete.
    if (looking === true) {
      releaseOsPointer();
      endWindowDrag();
    }
    // A fresh opinion - including "I can no longer see a face" - supersedes the
    // last pointer frame's routing.
    //
    // Reported: "when I look over at my iPad to control the blue cursor and look
    // back, the laptop also uses the dummy blue cursor on the app. The real mouse
    // pointer is not controlled any more. I have to manually toggle it back on."
    //
    // `lastPointer.gaze` was written on every frame and never cleared. Once the
    // head turned to the iPad it held 'tablet' indefinitely. When the user looked
    // back, the iPad's tracker lost their face and sent `looking: null`, which
    // makes `tabletGazeFresh()` false - so routing fell through to
    // `lastPointer.gaze`, which still said 'tablet'. The OS cursor stayed frozen
    // and the app kept drawing its own cursor, with no way back except toggling
    // the system pointer off and on.
    //
    // A null opinion means "no longer looking at this device", not "no opinion".
    // Treating it as laptop is correct: the tablet only claims control while it
    // can actually see the face that is looking at it.
    lastPointer.gaze = looking === true && receiverConnected() ? 'tablet' : 'laptop';
  });
  /**
   * The iPad's hand opened (or closed) in front of it.
   *
   * This is the half of the carry gesture the laptop physically cannot observe:
   * "grab it while looking at the laptop, look at the iPad, then open your hand".
   * While the user is looking at the tablet the laptop's webcam has no face to
   * track, so the service stops emitting gestures entirely and `window.release`
   * never arrives. The tablet does have the hand in view, so it reports the
   * change and the transfer is completed here.
   *
   * Only a fist -> open transition counts, and only while a carry is actually
   * held, so an idle hand in front of the iPad sends nothing.
   */
  client.on('tabletFist', (fist: boolean) => {
    const previousAt = tabletFistAt;
    tabletFist = fist;
    tabletFistAt = Date.now();
    if (fist) return;
    log.debug('ipc', 'iPad reports the hand open.', {
      carrying: grabHeld,
      afterFistFor: previousAt === 0 ? null : tabletFistAt - previousAt,
    });
    if (!grabHeld) return;
    // The release only means "send it" if the head is on the iPad. A hand that
    // opens while the user is still looking at the laptop is the laptop's own
    // release path, which the service will report itself.
    if (!tabletGazeFresh() || tabletGaze.looking !== true) return;
    handOffToTablet('tablet-fist');
  });
  client.on('welcome', ({ session: s, pairing }) => {
    if (pairing) emit(EV.pairing, pairing);
    emit(EV.status, { ...status(), session: s, pairing: pairing ?? client.pairing });
  });
  client.on('session', (s) => emit(EV.status, { ...status(), session: s }));
  client.on('pairing', (p) => emit(EV.pairing, p));
  client.on('error', (code: string, message: string) => {
    lastError = { code, message, at: Date.now() };
    emit(EV.error, code, message);
    emit(EV.status, status());
  });
  client.on('workspace', (msg) => {
    if (msg.t === 'server.workspace') emit(EV.workspace, msg.state);
  });
  client.on('panelSelect', (id: string) => emit(EV.panelSelect, id));
  client.on('panelClose', (id: string) => emit(EV.panelClose, id));
  client.on('panelReturn', (id: string) => emit(EV.panelReturn, id));
  client.on('panelMove', (id: string, rect: unknown) => emit(EV.panelMove, id, rect));
  client.on('modeSet', (mode: string) => emit(EV.modeSet, mode));
  client.on('command', (text: string, mode: string) => emit(EV.command, text, mode));
  client.on('stop', () => emit(EV.stop));
  client.on('approval', (id: string, accept: boolean) => emit(EV.approvalResponse, id, accept));
  client.on('signal', (msg: { t: string; req?: { sdp: string }; panelId: string; candidate?: unknown }) => {
    if (msg.t === 'server.answer' && msg.req) emit(EV.answer, msg.panelId, msg.req.sdp);
    if (msg.t === 'server.ice' && msg.candidate) emit(EV.iceRemote, msg.panelId, msg.candidate);
  });

  // ------------------------------------------------------------------------
  // Display capture: the renderer calls getDisplayMedia; this handler decides
  // exactly which window is captured and refuses anything not explicitly
  // granted a moment earlier.
  // ------------------------------------------------------------------------
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) return callback({});

      const grant = captureGrant;
      if (!grant || grant.used || Date.now() - grant.issuedAt > GRANT_TTL_MS) {
        // No grant: deny. A page can never escalate to whole-desktop capture.
        return callback({});
      }
      grant.used = true;

      try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        const target = sources.find((s) => s.id === grant.sourceId);
        if (!target) return callback({});
        callback({ video: target });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  // ------------------------------------------------------------------------
  // Renderer-facing handlers
  // ------------------------------------------------------------------------
  ipcMain.handle(IPC.getStatus, () => status());

  ipcMain.handle(IPC.getPrefs, (): OrbitPrefs => settings.prefs as OrbitPrefs);

  ipcMain.handle(IPC.setPrefs, (_e, patch: Partial<OrbitPrefs>): OrbitPrefs => {
    // Only known keys are written; anything else from the renderer is ignored.
    const clean: Partial<OrbitPrefs> = {};
    if (Array.isArray(patch.allowList)) {
      clean.allowList = {
        apps: asStringList(patch.allowList.apps),
        sites: asStringList(patch.allowList.sites),
        folders: asStringList(patch.allowList.folders),
      };
    }
    if (typeof patch.broadcastSourceId === 'string' || patch.broadcastSourceId === null) {
      clean.broadcastSourceId = patch.broadcastSourceId;
    }
    if (patch.voiceProvider === 'groq' || patch.voiceProvider === 'local' || patch.voiceProvider === 'none') {
      clean.voiceProvider = patch.voiceProvider;
    }
    if (typeof patch.retainTranscripts === 'boolean') clean.retainTranscripts = patch.retainTranscripts;
    if (typeof patch.onboardingComplete === 'boolean') clean.onboardingComplete = patch.onboardingComplete;
    if (typeof patch.gestureArmedByDefault === 'boolean') clean.gestureArmedByDefault = patch.gestureArmedByDefault;
    if (typeof patch.systemPointer === 'boolean') {
      clean.systemPointer = patch.systemPointer;
      // Turning the system pointer off mid-drag must not strand the button or
      // leave a window following the hand.
      if (!patch.systemPointer) {
        releaseOsPointer();
        endWindowDrag();
      }
    }
    return settings.update(clean) as OrbitPrefs;
  });

  ipcMain.handle(IPC.requestSources, async (_e, options: { thumbnails: boolean }) => {
    // Always ask for a thumbnail, even when the caller does not need one.
    //
    // Reported: "When I drop a window onto the iPad, it renders as a really
    // small black rectangle with the title 'status' I can't actually see the
    // window I dropped."
    //
    // That was a hidden helper window being treated as a capturable source. With
    // `thumbnailSize: {0,0}` there is no way to tell a real window from an
    // invisible 0x0 shell window: both enumerate with a name, and the invisible
    // one then captures as pure black. The thumbnail is the only cheap evidence
    // of whether a window actually has pixels, so it is now always requested and
    // the result is used as a filter.
    const wantsThumbs = options?.thumbnails !== false;
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    const win = getWindow();
    const selfTitle = win && !win.isDestroyed() ? win.getTitle() : '';

    return sources
      .filter((s) => {
        const name = s.name?.trim();
        if (!name) return false;
        if (name === selfTitle || name.startsWith('ORBIT')) return false;
        // A window with no thumbnail has no surface to capture. This is the
        // filter that would have stopped 'status' from being offered at all.
        const size = s.thumbnail.getSize();
        if (size.width <= 0 || size.height <= 0) return false;
        return true;
      })
      .map((s) => ({
        id: s.id,
        name: s.name,
        native: false,
        thumbnailDataUrl:
          wantsThumbs && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : undefined,
      }));
  });

  ipcMain.handle(IPC.grantCapture, (_e, sourceId: string) => {
    if (typeof sourceId !== 'string' || !/^(window|screen):/.test(sourceId)) {
      return { ok: false, reason: 'Unsupported source id.' };
    }
    if (sourceId.startsWith('screen:')) {
      // Whole-desktop sharing is a separate, clearly labelled mode later on.
      return { ok: false, reason: 'Desktop capture is not enabled. Choose a single window.' };
    }
    captureGrant = { sourceId, issuedAt: Date.now(), used: false };
    return { ok: true };
  });

  ipcMain.handle(IPC.startSession, (_e, catalog: SourceCatalog) => {
    client.startSession(sanitiseCatalog(catalog));
  });

  ipcMain.handle(IPC.stopSession, () => {
    client.stopSession();
  });

  ipcMain.handle(IPC.setActiveSource, (_e, sourceId: string | null) => {
    settings.update({ broadcastSourceId: typeof sourceId === 'string' ? sourceId : null });
    ipcMain.emit('orbit:source-changed');
  });

  ipcMain.handle(IPC.pushWorkspace, (_e, state: WorkspaceState) => {
    client.pushWorkspace(state);
  });

  ipcMain.handle(IPC.offer, (_e, panelId: string, sdp: string) => {
    client.offer({ kind: 'offer', sdp }, panelId);
  });

  ipcMain.handle(IPC.ice, (_e, panelId: string, candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }) => {
    client.ice(candidate, panelId);
  });

  ipcMain.handle(IPC.streamStop, (_e, panelId: string) => {
    client.streamStop(panelId);
  });

  ipcMain.handle(
    IPC.pushPointer,
    (_e, pointer: HandPointer, phase?: 'move' | 'click' | 'down' | 'up') => {
      if (!pointer || typeof pointer.x !== 'number' || typeof pointer.y !== 'number') return;
      const safe: HandPointer = {
        x: Math.min(1, Math.max(0, pointer.x)),
        y: Math.min(1, Math.max(0, pointer.y)),
        visible: Boolean(pointer.visible),
        target: pointer.target === 'tablet' || pointer.target === 'laptop' ? pointer.target : null,
      };
      const type =
        phase === 'click'
          ? 'desktop.pointer.click'
          : phase === 'down'
            ? 'desktop.pointer.down'
            : phase === 'up'
              ? 'desktop.pointer.up'
              : 'desktop.pointer';
      client.send({ t: type, pointer: safe });
    },
  );

  ipcMain.handle(IPC.revoke, (_e, receiverId: string) => {
    client.revoke(receiverId);
  });

  ipcMain.handle(IPC.pushTask, (_e, task) => {
    if (task) client.send({ t: 'desktop.task', task });
  });

  ipcMain.handle(IPC.pushApproval, (_e, approval) => {
    if (approval) client.send({ t: 'desktop.approval.request', approval });
  });

  ipcMain.handle(IPC.pushTranscript, (_e, transcript) => {
    if (transcript) client.send({ t: 'desktop.transcript', transcript });
  });

  ipcMain.handle(IPC.pushVoiceState, (_e, state: 'idle' | 'listening' | 'transcribing') => {
    client.send({ t: 'desktop.voice.state', state });
  });

  ipcMain.handle(IPC.openReceiverPage, async () => {
    const p = client.pairing;
    if (p) await shell.openExternal(p.url);
  });

  ipcMain.handle(IPC.openLogFolder, async () => {
    const dir = logDirectory();
    log.info('ipc', 'Opening the log folder.', { dir });
    const error = await shell.openPath(dir);
    return { ok: error === '', path: dir, file: logFile(), error: error || null };
  });

  ipcMain.handle(IPC.renderQr, async (_e, payload: string) => {
    if (typeof payload !== 'string' || payload.length > 512) throw new Error('Bad QR payload.');
    return QRCode.toDataURL(payload, {
      margin: 1,
      width: 400,
      errorCorrectionLevel: 'M',
      color: { dark: '#08090c', light: '#ffffff' },
    });
  });

  // ------------------------------------------------------------------------
  // Gesture service. The renderer can start/stop it and arm/disarm the
  // detector; everything else flows back as events.
  // ------------------------------------------------------------------------
  gestures.on('state', (state: string, error: string | null) => {
    // The service can stop or crash while a pinch is held; the OS button must
    // not outlive it, and a grabbed window must stop following a dead hand.
    if (state !== 'running') {
      releaseOsPointer();
      endWindowDrag();
    }
    log.info('ipc', `Gesture service state: ${state}.`, error ? { error } : undefined);
    if (state === 'running' && settings.prefs.gestureArmedByDefault) gestures.arm();
    emit(EV.gestureState, { state, error });
  });
  gestures.on('status', (status: unknown) => {
    // The iPad's gaze opinion rides along with the laptop's own reading.
    //
    // The renderer draws the carried-window preview from this, and it has to be
    // the *tablet's* opinion: the moment the user turns their head to the iPad
    // the laptop's webcam loses the face and its router reports no target at
    // all. Building the preview on that reading meant it appeared for the
    // fraction of a second between the turn and the loss, then vanished exactly
    // when the user was looking at it.
    const withTablet =
      status && typeof status === 'object'
        ? { ...(status as Record<string, unknown>), tabletGaze: { ...tabletGaze } }
        : status;
    emit(EV.gestureStatus, withTablet);
  });
  gestures.on('event', (event: unknown) => {
    const msg = event as {
      kind?: unknown;
      detail?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const kind = String(msg.kind ?? '');
    const detail = msg.detail ?? (msg.detail = {});

    if (kind === 'pointer.press' || kind === 'pointer.release') {
      const x = Number(detail['x'] ?? lastPointer.x);
      const y = Number(detail['y'] ?? lastPointer.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        lastPointer.x = x;
        lastPointer.y = y;
      }
      // The iPad's own gaze overrides the laptop's router, so the renderer's
      // relay decision and the OS action below always agree.
      const gaze = resolveGaze(detail['gaze']);
      detail['gaze'] = gaze;
      // Echo the preference the main process actually used. The renderer's
      // copy can be one React render behind a toggle, and disagreeing about
      // who performs the click would either double it or drop it.
      detail['systemPointer'] = settings.prefs.systemPointer;
      emit(EV.gestureEvent, msg);

      if (kind === 'pointer.press') {
        if (!settings.prefs.systemPointer || gaze === 'tablet') return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const point = toScreenPoint(x, y);
        log.info('ipc', 'Pointer press.', { x: point.x, y: point.y, gaze });
        systemPointer.press(point.x, point.y);
        osPressed = true;
        return;
      }

      // A release is always safe to perform locally: the press may have
      // happened before the head moved, and an unmatched up is harmless while
      // a missing one leaves the desktop stuck in a drag.
      if (osPressed) log.info('ipc', 'Pointer release.');
      releaseOsPointer();
      return;
    }

    if (kind === 'pointer.scroll') {
      const notches = Number(detail['notches'] ?? 0);
      const gaze = resolveGaze(detail['gaze']);
      detail['gaze'] = gaze;
      detail['systemPointer'] = settings.prefs.systemPointer;
      emit(EV.gestureEvent, msg);
      // One wheel event per notch, in the notch's own direction. The service
      // has already accumulated slow hand movement, so this is the only place
      // that needs to know Windows uses 120 units per detent.
      if (!settings.prefs.systemPointer || gaze === 'tablet') return;
      if (Number.isFinite(notches) && notches !== 0) systemPointer.wheel(notches);
      return;
    }

    if (kind === 'desktop.switch') {
      const direction = String(detail['direction'] ?? 'right');
      const gaze = resolveGaze(detail['gaze']);
      detail['gaze'] = gaze;
      detail['systemPointer'] = settings.prefs.systemPointer;
      emit(EV.gestureEvent, msg);
      // A left-hand fist switches the *laptop's* desktops, always.
      //
      // Reported: "the desktop switching is not working".
      //
      // It was gated on `gaze === 'tablet'` returning early, but the machine
      // emits `desktop.switch` with no gaze field of its own, so `resolveGaze`
      // fell through to `lastPointer.gaze` — the *right* hand's routing
      // decision. Once the right hand had been pointed at the iPad that value
      // stuck, and every subsequent left-fist sweep was silently discarded.
      // The two hands are independent gestures; the left one must not be
      // disabled by where the right one last went.
      //
      // The iPad is not involved either way: virtual desktops are a Windows
      // concept with no counterpart on the tablet, so there is nothing to route.
      // Only the master switch (systemPointer) still applies.
      if (!settings.prefs.systemPointer) return;
      log.info('ipc', 'Desktop switch.', { direction });
      systemPointer.switchDesktop(direction === 'left' ? -1 : 1);
      // ORBIT is the screen the user is controlling from, so it must not ride
      // along to the desktop they just left. The swipe moves *everything*, ORBIT
      // included; without this the app ended up on the far desktop and looked
      // dead. Sent after the switch, once the new desktop exists to move onto.
      scheduleRepin();
      return;
    }

    if (kind === 'window.grab') {
      // A grab always belongs to the machine the hand is in front of.
      //
      // Reported: "When I look at the laptop and try to grab a window, nothing
      // happens, i cant drag the window around."
      //
      // This used to bail out whenever `currentOwner()` said 'tablet', and that
      // owner is derived from `lastPointer.gaze` — a value that latches to
      // 'tablet' as soon as the head turns to the iPad and does not reset on its
      // own. So after any session on the iPad, every later laptop grab was
      // discarded before it could start. Exactly the same latch that broke
      // desktop switching, in a second place.
      //
      // The machine emits `window.grab` only when the right hand is physically
      // held in front, and it emits `window.release` with a fresh gaze reading
      // at the end. Routing is decided there, on release, where the head really
      // is pointing — never inherited from a stale pointer frame.
      grabOwner = 'laptop';
      // A new carry, from the only camera that can see it start.
      grabHeld = true;
      grabHeldAt = Date.now();
      emit(EV.gestureEvent, msg);
      // The renderer adds the captured panel; this moves the real window too.
      beginWindowDrag();
      return;
    }

    if (kind === 'window.release') {
      endWindowDrag();
      // Disarming is a cancel, not a routing decision: whatever the user was
      // looking at when they turned gestures off, the window stays where it is.
      const cancelled = detail['cancelled'] === true;
      const gaze = cancelled ? 'laptop' : resolveGaze(detail['gaze']);
      detail['gaze'] = gaze;
      const fromTablet = grabOwner === 'tablet';
      grabOwner = 'laptop';
      // A grab that never reached the laptop has no laptop window to release.
      if (fromTablet) return;
      emit(EV.gestureEvent, msg);
      // Releasing while looking at the iPad *is* the send gesture.
      //
      // Reported: "I should look over at the laptop, cup my fist in front to
      // select the window, and when i look over at my iPad with something in my
      // hand, it should show a preview of the window I have and if I look away it
      // should disappear. But if i look at my iPad and release my fist, the
      // window transfer should take place."
      //
      // The previous design required the window to be physically dragged past
      // the laptop screen edge before it would move, which made the transfer
      // reachable only by shoving the window off-screen - not what "carry it over
      // by looking" means. Releasing toward the iPad is deliberate: the preview
      // is already visible there, so the user has seen exactly what they are
      // about to send and the release is the confirmation.
      //
      // The handoff handler also clears `grabHeld`, so the two paths cannot both
      // send the same window: whichever sees the release first wins.
      const sent = gaze === 'tablet' && receiverConnected() ? handOffToTablet('release') : false;
      if (!sent && gaze === 'tablet') {
        // An iPad that has gone away mid-carry: the release still ends the
        // carry, it just has nowhere to send it.
        log.info('ipc', 'Released a carried window with no iPad connected.', {});
      }
      // The carry is over either way: released, sent, or nowhere to go.
      grabHeld = false;
      grabHeldAt = 0;
      return;
    }

    if (kind === 'gesture.reset' || kind === 'tracking.lost') {
      // Only a real reset ends the grab. `tracking.lost` fires on the first
      // frame the hand or face is missing, and it fires on single-frame
      // MediaPipe dropouts too; ending the drag there released the window
      // before the 300 ms grace in the service had a chance to hold it. The
      // service emits `gesture.reset` once tracking has been gone long enough.
      if (kind === 'gesture.reset') {
        endWindowDrag();
        // A reset caused by the head turning to the iPad is not a cancel: the
        // carry is what the turn is for, and the iPad will report the release.
        // Any other reset (hand lowered, camera lost, tracking disarmed) is.
        if (resolveGaze(undefined) !== 'tablet') {
          grabHeld = false;
          grabHeldAt = 0;
        }
      }
    }

    if (kind === 'dictation.start') {
      if (currentOwner() === 'tablet') return;
      emit(EV.gestureEvent, msg);
      if (!settings.prefs.systemPointer) return;
      // Dictation behaves like WisprFlow rather than a bare Win+H toggle.
      //
      // Reported: "I need dictation to work properly as well. Similar to
      // wisprflow. I should be able to dictate and it will paste that text into
      // the selected text field or if no text field is selected, there should be
      // a copy option."
      //
      // So: work out *now*, before speaking starts, whether a text field has
      // focus. That decides what happens when the cup ends — paste into the
      // field, or leave the transcription on the clipboard. Checking at the end
      // would be wrong: the act of gesturing can move focus.
      dictationTarget = null;
      void systemPointer.hasFocusedTextField().then((focused) => {
        dictationTarget = focused ? 'field' : 'clipboard';
        emit(EV.gestureEvent, {
          type: 'gesture',
          kind: 'dictation.mode',
          detail: { target: dictationTarget },
        });
      });
      systemPointer.toggleDictation();
      return;
    }

    if (kind === 'dictation.stop') {
      if (currentOwner() === 'tablet') return;
      emit(EV.gestureEvent, msg);
      if (!settings.prefs.systemPointer) return;
      // Win+H is a toggle, so ending the cup turns voice typing back off rather
      // than leaving the microphone live after the hand comes down.
      systemPointer.toggleDictation();
      // Windows voice typing inserts straight into the focused field when there
      // is one, so the paste is only needed when we do not have that path. When
      // there is no field the transcription has already been copied to the
      // clipboard by Windows, and the renderer offers it to the user.
      if (dictationTarget === 'clipboard') {
        emit(EV.gestureEvent, {
          type: 'gesture',
          kind: 'dictation.copied',
          detail: { target: 'clipboard' },
        });
      }
      dictationTarget = null;
      return;
    }

    if (kind === 'pointer.click') {
      // Legacy one-shot. Keep it consistent with press/release so a stale
      // service build cannot disagree with the renderer about which screen
      // owns the click, or double-click because both sides acted on it.
      detail['gaze'] = resolveGaze(detail['gaze']);
      detail['systemPointer'] = settings.prefs.systemPointer;
    }

    emit(EV.gestureEvent, msg);

    // Legacy one-shot click. The service now emits press/release, but a stale
    // helper or a replayed event must still click rather than do nothing.
    if (kind !== 'pointer.click' || !settings.prefs.systemPointer) return;
    if (detail['gaze'] === 'tablet') return;
    const x = Number(detail['x'] ?? lastPointer.x);
    const y = Number(detail['y'] ?? lastPointer.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    lastPointer.x = x;
    lastPointer.y = y;
    const point = toScreenPoint(x, y);
    systemPointer.click(point.x, point.y);
  });
  gestures.on('pointer', (frame: PointerFrameMessage) => {
    // Disarmed means "no hand-driven mouse control", movement included. The
    // preview still receives the position through the status stream, but the
    // real cursor must not be moved by a control the user turned off.
    if (!frame.armed) {
      releaseOsPointer();
      endWindowDrag();
      grabHeld = false;
      grabHeldAt = 0;
      return;
    }
    // The iPad's live reading wins. Without one, fall back to the service's
    // head-pose router. The renderer uses the same value for the relayed
    // cursor, so both sides switch screens on the same frame.
    // The service's gaze is live, so it outranks the remembered one.
    //
    // `lastPointer.gaze` is only ever a fallback for a frame that carries no
    // routing of its own. Preferring the sticky value over `frame.gaze` is what
    // pinned control to the iPad after the head had already come back: the iPad
    // had stopped reporting (stale), but the remembered value still said
    // 'tablet'. The freshly measured gaze is the better evidence every time.
    const decidedFromService = frame.gaze === 'tablet' || frame.gaze === 'laptop';
    const decided = tabletGazeFresh()
      ? tabletGaze.looking
        ? 'tablet'
        : 'laptop'
      : decidedFromService
        ? frame.gaze
        : lastPointer.gaze === 'tablet'
          ? 'tablet'
          : 'laptop';
    // No iPad: keep the OS cursor on this laptop even if the head is turned
    // toward where the iPad would be. Otherwise movement stops at the worst
    // possible moment and the user reasonably reads it as "gestures are broken".
    const gaze = decided === 'tablet' && !receiverConnected() ? 'laptop' : decided;
    lastPointer.gaze = gaze;

    if (gaze === 'tablet') {
      // The hand follows the head: while the user looks at the iPad the OS
      // cursor stays put and the receiver draws the local iPad cursor instead.
      // The physical drag ends too - the window must not travel to a screen it
      // is not on - but the carry itself survives, so releasing the hand on the
      // iPad can still complete it.
      releaseOsPointer();
      endWindowDrag();
      // Forget a carry nobody ever finished. Without this a hand that vanished
      // mid-carry would leave a window claimed indefinitely.
      if (grabHeld && grabHeldAt !== 0 && Date.now() - grabHeldAt > CARRY_TIMEOUT_MS) {
        grabHeld = false;
        grabHeldAt = 0;
      }
      return;
    }
    if (!frame.handVisible || frame.x === null || frame.y === null) {
      // Freeze both the cursor and a grabbed window where they are. A single
      // MediaPipe dropout used to drop the window instantly; the service keeps
      // the grab through its grace window and emits `gesture.reset` when
      // tracking is really gone, which is what ends the physical move.
      return;
    }
    if (!settings.prefs.systemPointer) return;
    lastPointer.x = frame.x;
    lastPointer.y = frame.y;

    // While scrolling, keep the cursor where it is: the vertical hand motion is
    // the wheel, and dragging the pointer across the screen at the same time
    // makes the page impossible to aim at.
    //
    // A grabbed window is the exception. Bailing out here for the drag too meant
    // a fist that drifted a few frames into the scroll *pose* stopped the window
    // dead and started scrolling the page instead — the "moving windows does not
    // work at all" report. Once a window is physically held, the drag owns the
    // frame: the whole point of the grab is to move the window, not the page.
    if (frame.scrolling && !windowDrag) return;

    if (!windowDrag) {
      const point = toScreenPoint(frame.x, frame.y);
      systemPointer.move(point.x, point.y);
      return;
    }

    // Direct manipulation: a hand movement of one screen width moves the window
    // the same distance. The grab origin is the hand position at the moment the
    // hold completed, so the window does not jump on pickup.
    //
    // Eased rather than snapped. Window positions were sent raw every frame and
    // rounded to whole pixels, so at 30 Hz with landmark jitter the window
    // juddered and could jump several pixels on a single bad frame. Following a
    // target that moves a fraction of the way each frame turns those jumps into
    // motion the eye reads as smooth, and it costs one frame of latency.
    const targetX = windowDrag.left + (frame.x - windowDrag.grabX) * windowDrag.screenWidth;
    const targetY = windowDrag.top + (frame.y - windowDrag.grabY) * windowDrag.screenHeight;

    // Ease first, then decide, so the edge test sees where the window actually
    // is this frame rather than where it was at the start of it.
    if (windowDrag.smoothX === null || windowDrag.smoothY === null) {
      windowDrag.smoothX = targetX;
      windowDrag.smoothY = targetY;
    } else {
      windowDrag.smoothX += (targetX - windowDrag.smoothX) * WINDOW_DRAG_EASING;
      windowDrag.smoothY += (targetY - windowDrag.smoothY) * WINDOW_DRAG_EASING;
    }

    // Hand the window to the iPad only when the user *deliberately* pushes it off
    // the laptop while looking at the tablet.
    //
    // Reported: "If I grab it, it should move within the laptop first. Only if I
    // then look at the iPad and drag the window out of bounds of the computer
    // screen, should it hide it from the computer and transfer it to the iPad."
    //
    // So the drag is bounded by the laptop and gaze alone never moves a window.
    // Crossing the edge while looking at the laptop just stops at the border;
    // crossing it while looking at the tablet is the handoff.
    if (!windowDrag.handedOff) {
      const { screenLeft, screenTop, screenWidth, screenHeight } = windowDrag;
      const lookingAtTablet = resolveGaze(lastPointer.gaze) === 'tablet';
      // The window must be *at* the edge, not merely past it.
      //
      // Hand coordinates are normalised 0..1, so the furthest the window can
      // travel is one screen width from where it was grabbed — and a window
      // grabbed mid-screen never reaches a point 15% of a screen *beyond* the
      // right edge. An overshoot threshold made the handoff unreachable in
      // practice. Touching the edge is already deliberate: the drag is clamped
      // there, so the user has visibly pushed as far as they can go.
      const overshoot = 0;
      const pastLeft = windowDrag.smoothX !== null && windowDrag.smoothX < screenLeft - overshoot;
      const pastRight =
        windowDrag.smoothX !== null && windowDrag.smoothX > screenLeft + screenWidth + overshoot;
      const pastTop = windowDrag.smoothY !== null && windowDrag.smoothY < screenTop - overshoot;
      const pastBottom =
        windowDrag.smoothY !== null &&
        windowDrag.smoothY > screenTop + screenHeight + overshoot;

      if (lookingAtTablet && (pastLeft || pastRight || pastTop || pastBottom)) {
        windowDrag.handedOff = true;
        // One implementation of "send it": it also ends the physical drag and
        // clears the carry, so a release that follows cannot send it twice.
        handOffToTablet('release');
        return;
      }
    }
    // Keep the window on the laptop while the user is looking at the laptop.
    //
    // This is the other half of the report: "it should move within the laptop
    // first". Without a clamp the window followed the hand straight off the
    // right edge and vanished from the screen it was being dragged on, which is
    // not what picking a window up should do.
    const bounds = windowDrag;
    const clampMinX = bounds.screenLeft;
    const clampMaxX = bounds.screenLeft + bounds.screenWidth;
    const clampMinY = bounds.screenTop;
    const clampMaxY = bounds.screenTop + bounds.screenHeight;
    const restingOnLaptop = resolveGaze(lastPointer.gaze) !== 'tablet';
    const sendX = restingOnLaptop
      ? Math.min(Math.max(windowDrag.smoothX, clampMinX), clampMaxX)
      : windowDrag.smoothX;
    const sendY = restingOnLaptop
      ? Math.min(Math.max(windowDrag.smoothY, clampMinY), clampMaxY)
      : windowDrag.smoothY;
    systemPointer.moveWindow(sendX, sendY);
  });
  gestures.on('error', (message: string) => {
    log.error('ipc', 'Gesture bridge reported an error.', message);
    releaseOsPointer();
    endWindowDrag();
    emit(EV.gestureState, { state: 'failed', error: message });
  });

  ipcMain.handle(IPC.gestureStart, () => gestures.start());
  ipcMain.handle(IPC.gestureRestart, () => {
    releaseOsPointer();
    endWindowDrag();
    return gestures.restart();
  });
  ipcMain.handle(IPC.gestureStop, () => {
    releaseOsPointer();
    endWindowDrag();
    gestures.stop();
  });
  ipcMain.handle(IPC.gestureArm, () => {
    const ok = gestures.arm();
    // Persist the choice here, with the action, so a camera restart keeps the
    // user's intent even if the renderer never gets to write the preference.
    if (ok) settings.update({ gestureArmedByDefault: true });
    return {
      ok,
      message: ok
        ? 'Armed. Pinch to click and hold to drag; raise a fist in front to grab the active window.'
        : 'The gesture service is not running yet.',
    };
  });
  ipcMain.handle(IPC.gestureDisarm, () => {
    // Do not wait for the service to acknowledge: a disarm is a safety action,
    // and a wedged helper must not leave the OS button down or a window moving.
    releaseOsPointer();
    endWindowDrag();
    const ok = gestures.disarm();
    if (ok) settings.update({ gestureArmedByDefault: false });
    return {
      ok,
      message: ok
        ? 'Disarmed. The hand no longer moves the cursor, and clicks and grabs are off.'
        : 'The gesture service is not running.',
    };
  });
  ipcMain.handle(IPC.gestureCalibrate, () => {
    const ok = gestures.calibrate();
    return {
      ok,
      message: ok
        ? 'Capturing your palm pose — the cursor should jump to the middle.'
        : 'The gesture service is not running.',
    };
  });
  ipcMain.handle(IPC.gestureGazeCalibrate, (_e, target: 'laptop' | 'tablet') => {
    const which: 'laptop' | 'tablet' = target === 'tablet' ? 'tablet' : 'laptop';
    const ok = gestures.calibrateGaze(which);
    return {
      ok,
      message: ok
        ? which === 'tablet'
          ? 'Recording this head angle as “looking at the iPad”. Now look at the laptop and press the other button.'
          : 'Recording this head angle as “looking at the laptop”. Now look at the iPad and press the other button.'
        : 'The gesture service is not running.',
    };
  });
  ipcMain.handle(IPC.gestureState, () => ({ state: gestures.state, error: null }));
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').slice(0, 200);
}

function sanitiseCatalog(catalog: SourceCatalog): SourceCatalog {
  const sources = Array.isArray(catalog?.sources)
    ? catalog.sources
        .filter((s) => typeof s?.id === 'string' && typeof s?.name === 'string')
        .slice(0, 100)
    : [];
  const activeSourceId =
    typeof catalog?.activeSourceId === 'string' && sources.some((s) => s.id === catalog.activeSourceId)
      ? catalog.activeSourceId
      : null;
  return { sources, activeSourceId };
}
