import { useEffect, useRef, useState } from 'react';
import type { SharedProps } from '../App.js';
import { api, on, type GazeTarget, type GestureStatus } from '../env.js';

/**
 * Gestures page — camera preview with joint mapping and gesture identification.
 *
 * This is a *visualisation*, not a video feed. The Python service never sends
 * frames: it sends the MediaPipe landmark coordinates over the local socket, and
 * the canvas below draws the joint skeleton from those numbers. Nothing visual
 * leaves the machine, and the preview keeps working even if the camera image
 * itself is never retained anywhere.
 *
 * The preview matches what the user sees in a mirror because the camera service
 * mirrors the frame with `cv2.flip` *before* MediaPipe reads it. The landmark x
 * values are therefore already in the user's left/right frame, and the canvas
 * must NOT flip them again — doing so drew the skeleton one way and the pointer
 * dot the other, which felt like an inverted cursor.
 */

/** MediaPipe hand connections (index-pairs into the 21-point hand landmark list). */
const HAND_BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Face oval + brows + eyes + lips, enough to read as a face without closing it. */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
const FACE_BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const FACE_EYES = [33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380];
const FACE_LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

/** Fingertip landmark indexes, highlighted so a pinch is easy to read. */
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

interface Label {
  text: string;
  tone: 'accent' | 'warn' | 'danger' | 'plain';
}

/**
 * Turn the raw status into one plain-language gesture name. The status carries
 * several overlapping booleans (curl, pinch, at-mouth, in-front), so the order
 * here is the priority order: the most deliberate gesture wins.
 */
function identify(status: GestureStatus): Label[] {
  const labels: Label[] = [];

  if (!status.handVisible && !status.faceVisible) {
    labels.push({ text: 'No hand or face', tone: 'plain' });
    return labels;
  }
  if (!status.handVisible) {
    // A hand is in view but it is not the right hand the cursor follows. That is
    // not an error: the left hand drives the desktop swipe on its own. Saying
    // "use your right" made a perfectly usable frame look broken.
    labels.push(
      status.handDetected
        ? { text: 'Left hand — desktop swipe; raise right to point', tone: 'plain' }
        : { text: 'Face only', tone: 'plain' },
    );
    return labels;
  }

  if (status.scrolling) {
    labels.push({ text: 'Scroll — move your hand up or down', tone: 'accent' });
  } else if (status.pinch) {
    const d = status.pinchDistance;
    labels.push({ text: d === null ? 'Pinch' : `Pinch (${d.toFixed(2)})`, tone: 'accent' });
  }
  if (status.atMouth) labels.push({ text: 'Cupped at mouth', tone: 'accent' });
  else if (status.inFront) labels.push({ text: 'Fist in front', tone: 'accent' });
  else if (status.curled) {
    // Closed, but not in either action band: the user needs to know where to
    // move it, otherwise a correct fist reads as "nothing happened".
    labels.push({ text: 'Fist — hold it in front of your chest', tone: 'warn' });
  } else labels.push({ text: 'Open hand', tone: 'plain' });

  if (status.atMouth && status.armed) labels.push({ text: 'Dictation', tone: 'accent' });

  const gaze = status.gaze;
  if (gaze?.target) {
    // Works with or without calibration: the default split already decides
    // which screen the head is turned to.
    labels.push({
      text: gaze.target === 'tablet' ? 'Looking at iPad' : 'Looking at laptop',
      tone: 'accent',
    });
  } else if (gaze?.mode === 'default' && gaze.yaw != null) {
    labels.push({ text: 'Head between screens', tone: 'plain' });
  }

  return labels;
}

export function GesturesPage({ camera, state, setState }: SharedProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<GestureStatus | null>(null);
  const [lastEvent, setLastEvent] = useState<{ kind: string; message: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [gazeNote, setGazeNote] = useState<string | null>(null);

  const systemPointer = state.systemPointer;
  const setSystemPointer = async (next: boolean): Promise<void> => {
    // Apply immediately so the overlay/cursor switches without waiting for the
    // store round-trip; revert if the write fails.
    setState((s) => ({ ...s, systemPointer: next }));
    try {
      await api().setPrefs({ systemPointer: next });
    } catch {
      setState((s) => ({ ...s, systemPointer: !next }));
      setGazeNote('Could not save the pointer setting.');
    }
  };

  /**
   * Arm or disarm hand control.
   *
   * This is the master switch for the hand mouse: when it is off the main
   * process stops moving the real cursor as well as discarding pinch-clicks and
   * fist-grabs. Without a visible switch the app could look alive ("the pointer
   * moves") while every action was silently dropped — which is exactly how the
   * unarmed state was reported. The choice is persisted with the arm/disarm
   * command, and is deliberately independent of whether an iPad is connected.
   */
  const armed = status?.armed ?? false;
  const [arming, setArming] = useState(false);
  const setArmed = async (next: boolean): Promise<void> => {
    setArming(true);
    setGazeNote(null);
    try {
      const result = next ? await api().gestureArm() : await api().gestureDisarm();
      if (!result.ok) {
        setGazeNote(result.message);
        return;
      }
      // The main process persists the preference alongside the arm/disarm, so
      // there is nothing else to write here.
    } catch {
      setGazeNote('Could not change hand-control arming.');
    } finally {
      setArming(false);
    }
  };

  // Live status arrives at ~12 Hz. Keeping it in state is fine (React batches)
  // but we also mirror it into a ref so the draw loop always paints the newest
  // frame without re-subscribing the animation.
  const statusRef = useRef<GestureStatus | null>(null);

  useEffect(() => {
    const offs = [
      on('orbit:ev-gesture-status', (next) => {
        statusRef.current = next;
        setStatus(next);
      }),
      on('orbit:ev-gesture-event', (event) => {
        setLastEvent({ kind: event.kind, message: event.message });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Drop the stale frame while a restart is in flight, so the preview cannot
  // keep showing a frozen skeleton from a service that no longer exists.
  useEffect(() => {
    if (camera === 'starting' || camera === 'off' || camera === 'failed') {
      statusRef.current = null;
      setStatus(null);
    }
  }, [camera]);

  const restartCamera = async (): Promise<void> => {
    setRestarting(true);
    setRestartNote(null);
    try {
      const result = await api().gestureRestart();
      setRestartNote(result.ok ? null : result.message);
      if (!result.ok) setRestarting(false);
    } catch {
      setRestartNote('Could not restart the camera.');
      setRestarting(false);
    }
  };

  /**
   * Open the folder holding the persistent log.
   *
   * The app used to keep every diagnostic in the terminal that launched it, so a
   * freeze after that window was closed left no evidence at all. The file is
   * written continuously and rotated, and this is how the user can hand it over.
   */
  const openLogs = async (): Promise<void> => {
    try {
      const result = await api().openLogFolder();
      if (!result.ok) setRestartNote(result.error ?? 'Could not open the log folder.');
    } catch {
      setRestartNote('Could not open the log folder.');
    }
  };

  // The service reports back through the camera state; clear the busy flag once
  // it is no longer starting.
  useEffect(() => {
    if (restarting && camera !== 'starting') setRestarting(false);
  }, [camera, restarting]);

  // Calibration is applied to the *latest frame* the service saw, so pressing
  // the button captures whatever pose the hand is in at that moment. The result
  // comes back as an event, not as the return value, so the busy state clears on
  // the event or after a short timeout.
  const calibrateAim = async (): Promise<void> => {
    setCalibrating(true);
    try {
      const result = await api().gestureCalibrate();
      if (!result.ok) setRestartNote(result.message);
    } catch {
      setRestartNote('Could not send the calibration request.');
    }
  };

  useEffect(() => {
    if (!calibrating) return;
    const timer = setTimeout(() => setCalibrating(false), 1200);
    return () => clearTimeout(timer);
  }, [calibrating]);

  useEffect(() => {
    if (calibrating && lastEvent?.kind.startsWith('pointer.calibrate')) setCalibrating(false);
  }, [lastEvent, calibrating]);

  const calibrateGaze = async (target: GazeTarget): Promise<void> => {
    setGazeNote(null);
    try {
      const result = await api().gestureGazeCalibrate(target);
      setGazeNote(result.ok ? null : result.message);
    } catch {
      setGazeNote('Could not send the gaze calibration request.');
    }
  };

  // Surface the service's own explanation for a failed capture: two anchors
  // that are too close together cannot separate the screens, and silently
  // ignoring that would leave gaze routing looking broken.
  useEffect(() => {
    if (lastEvent?.kind.startsWith('gaze.calibrate')) {
      setGazeNote(lastEvent.message);
    }
  }, [lastEvent]);

  // ---------------------------------------------------------------------
  // Canvas: draw the landmark skeleton from the coordinate stream.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w === 0 || h === 0) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const current = statusRef.current;
      const [rw, rh] = current?.resolution ?? [0, 0];
      if (!current || !rw || !rh) return;

      // Letterbox the camera aspect ratio inside the canvas box.
      const scale = Math.min(w / rw, h / rh);
      const ox = (w - rw * scale) / 2;
      const oy = (h - rh * scale) / 2;

      // Landmarks are normalised [0,1] against the frame. `tracker.py` already
      // mirrors the frame with `cv2.flip` before MediaPipe sees it, so x is
      // *already* in the user's left/right frame. Flipping again here put the
      // skeleton one way and the pointer dot the other, which read as an
      // inverted cursor: drag left and the dot went right.
      const px = (x: number): number => ox + x * rw * scale;
      const py = (y: number): number => oy + y * rh * scale;

      // `noUncheckedIndexedAccess` is on, so a landmark is `number[]` and its
      // entries may be `undefined`. A point is only usable when both are real.
      type Point = { x: number; y: number };
      const point = (p: number[] | undefined): Point | null => {
        if (!p) return null;
        const [x, y] = p;
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        return { x: px(x), y: py(y) };
      };

      const face = current.landmarks.face;
      const hand = current.landmarks.hand;

      // Face: thin, low-contrast lines. It is context, not the subject.
      if (face.length > 0) {
        ctx.strokeStyle = 'rgba(147, 160, 180, 0.38)';
        ctx.lineWidth = 1 * dpr;
        const polyline = (indexes: number[], close = false): void => {
          ctx.beginPath();
          indexes.forEach((i, n) => {
            const p = point(face[i]);
            if (!p) return;
            if (n === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          if (close) ctx.closePath();
          ctx.stroke();
        };
        polyline(FACE_OVAL, true);
        polyline(FACE_BROWS);
        polyline(FACE_EYES);
        polyline(FACE_LIPS);
      }

      // Hands: bright accent bones, the subject of the preview.
      //
      // Both hands are drawn. The tracker follows two, and the left one drives
      // the desktop swipe, so hiding it made it look as though only the right
      // hand was ever seen. The driving hand keeps the brighter treatment.
      const drawn = current.landmarks.hands?.length
        ? current.landmarks.hands
        : [{ label: 'Right', points: hand }];

      const drawHand = (points: number[][], driving: boolean): void => {
        if (points.length === 0) return;
        const curling = driving && current.curled;
        const alpha = driving ? 0.9 : 0.5;
        ctx.strokeStyle = driving && current.pinch
          ? 'rgba(92, 225, 196, 0.95)'
          : `rgba(92, 225, 196, ${alpha})`;
        ctx.lineWidth = (driving ? 2 : 1.5) * dpr;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const [a, b] of HAND_BONES) {
          const pa = point(points[a]);
          const pb = point(points[b]);
          if (!pa || !pb) continue;
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
        }
        ctx.stroke();

        for (let i = 0; i < points.length; i += 1) {
          const p = point(points[i]);
          if (!p) continue;
          const tip = FINGERTIPS.has(i);
          ctx.beginPath();
          ctx.arc(p.x, p.y, (tip ? 3.4 : 2.1) * dpr, 0, Math.PI * 2);
          ctx.fillStyle = tip
            ? driving
              ? '#5ce1c4'
              : 'rgba(92, 225, 196, 0.6)'
            : 'rgba(238, 241, 246, 0.85)';
          ctx.fill();
        }

        // Palm-centre marker: the anchor the curl measurement is taken around.
        const palm = point(points[9]);
        if (palm) {
          ctx.beginPath();
          ctx.arc(palm.x, palm.y, 5.5 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = curling ? 'rgba(245, 184, 92, 0.85)' : 'rgba(92, 225, 196, 0.55)';
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke();
        }
      };

      // Non-driving hands first, so the cursor hand is never hidden behind one.
      for (const entry of drawn) {
        if (entry.label.toLowerCase() !== 'right') drawHand(entry.points, false);
      }
      for (const entry of drawn) {
        if (entry.label.toLowerCase() === 'right') drawHand(entry.points, true);
      }
      // If no hand carried a usable label, still draw what was detected.
      if (!drawn.some((entry) => entry.label.toLowerCase() === 'right')) {
        drawHand(drawn[0]?.points ?? hand, true);
      }

      // The follow line: palm to cursor. It ends *exactly* at the pointer,
      // because both are drawn from the same value — the line is the
      // explanation of the dot, not a separate estimate.
      //
      // The cursor is the palm's position scaled up around the calibrated
      // centre, so this line shows how far the hand has been amplified. It is
      // not an aim ray; the palm's normal no longer drives anything.
      if (current.pointer) {
        const [x, y] = current.pointer;
        const cursorX = ox + x * rw * scale;
        const cursorY = oy + y * rh * scale;
        const palm = point(hand[9]);

        if (palm) {
          ctx.save();
          ctx.setLineDash([6 * dpr, 5 * dpr]);
          ctx.strokeStyle = 'rgba(245, 184, 92, 0.7)';
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          ctx.moveTo(palm.x, palm.y);
          ctx.lineTo(cursorX, cursorY);
          ctx.stroke();
          ctx.restore();
        }

        // The cursor itself. One dot, drawn once, at the end of the line.
        ctx.beginPath();
        ctx.arc(cursorX, cursorY, 6 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(245, 184, 92, 0.95)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(8, 9, 12, 0.9)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const labels = status ? identify(status) : [];
  const ready = status !== null;
  // The camera no longer waits for an iPad: it starts with the app. `camera` is
  // the real service state, so the empty preview explains itself honestly.
  const cameraLive = camera === 'live';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Gestures</h1>
          <p>
            Live camera preview with joint mapping. The skeleton is drawn from landmark coordinates
            computed on this laptop — no video and no frames are sent anywhere.
          </p>
        </div>
        <div className="actions">
          <span className={`badge ${ready ? 'accent' : 'warn'}`}>{ready ? 'Tracking' : 'No data'}</span>
          {status?.gaze?.target ? (
            <span className="badge accent" title="Which screen the head is turned to.">
              {status.gaze.target === 'tablet' ? 'Eyes: iPad' : 'Eyes: laptop'}
            </span>
          ) : null}
          <button
            className="btn btn-ghost"
            onClick={() => void calibrateAim()}
            disabled={calibrating || !ready}
            title="Hold your hand where you want the middle of the screen to be, then press this. That hand position becomes dead centre."
          >
            {calibrating ? 'Centring…' : 'Centre cursor'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void calibrateGaze('laptop')}
            disabled={!ready || !status?.faceVisible}
            title="Optional refinement: look at the laptop, then press this. Without it, facing the camera already counts as the laptop."
          >
            Look at laptop
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void calibrateGaze('tablet')}
            disabled={!ready || !status?.faceVisible}
            title="Optional refinement: turn to the iPad, then press this. Without it, a large turn either way already counts as the iPad."
          >
            Look at iPad
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void restartCamera()}
            disabled={restarting}
            title="Stop and start the camera service again — use this after a failed start or if another app was holding the webcam"
          >
            {restarting ? 'Restarting…' : 'Restart camera'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void openLogs()}
            title="Open the folder with ORBIT's persistent log (orbit.log). Useful if the app ever freezes or a gesture stops responding."
          >
            Open logs
          </button>
        </div>
      </div>

      <label className="toggle" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={armed}
          disabled={!cameraLive || arming}
          onChange={(e) => void setArmed(e.target.checked)}
        />
        Enable hand control — pinch to left-click (hold to drag), raised fist to grab the active window.
      </label>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, margin: '0 0 14px' }}>
        {armed
          ? 'Armed. Pinching presses and holds the left mouse button; a fist held in front grabs the active window. Works with or without an iPad connected.'
          : 'Disarmed. The hand no longer moves the pointer and pinch-clicks, drags and fist-grabs are off. Tick this box to hand control back.'}
      </p>

      <label className="toggle" style={{ marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={systemPointer}
          onChange={(e) => void setSystemPointer(e.target.checked)}
        />
        Control the real Windows pointer — the hand moves the system cursor, and a pinch clicks
        wherever it is, in any app.
      </label>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, margin: '0 0 14px' }}>
        {systemPointer
          ? 'The in-app overlay is hidden because the real pointer is being driven. The cursor follows the screen your head is turned to.'
          : 'Overlay mode: the hand cursor is drawn inside ORBIT only. Pinch clicks still work on ORBIT controls, but cannot reach other apps.'}
      </p>

      {restartNote ? (
        <div className="banner bad" style={{ marginBottom: 14 }}>
          <span>{restartNote}</span>
        </div>
      ) : null}

      {status?.cameraDark ? (
        <div className="banner bad" style={{ marginBottom: 14 }}>
          <span>
            The camera is sending black frames (brightness {status.cameraMean.toFixed(0)}/255), so
            no hand can be detected — this is not an empty room. Another app may still hold the
            webcam, or the privacy shutter or lens cover is closed. ORBIT reopens the device
            automatically; if this stays, press Restart camera.
          </span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => void restartCamera()}
            disabled={restarting}
          >
            Restart camera
          </button>
        </div>
      ) : null}

      {gazeNote ? (
        <div className="banner" style={{ marginBottom: 14 }}>
          <span>{gazeNote}</span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => setGazeNote(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="grid-2 gesture-grid">
        <div className="card">
          <h2>
            Camera preview
            <span className="sub">
              {ready
                ? `${status!.resolution[0]}×${status!.resolution[1]} · ${status!.fps} fps`
                : camera === 'failed'
                  ? 'Camera unavailable'
                  : cameraLive
                    ? 'Waiting for the first frame'
                    : 'Starting the camera…'}
            </span>
          </h2>

          <div className="gesture-stage">
            <canvas ref={canvasRef} className="gesture-canvas" aria-label="Camera landmark preview" />
            {!ready ? (
              <div className="gesture-stage-empty">
                {camera === 'failed'
                  ? state.error?.message ??
                    'The camera could not start. Press Restart camera; the reason will be shown here.'
                  : cameraLive
                    ? 'Camera is running. Put a hand in view.'
                    : 'Camera starting…'}
              </div>
            ) : null}
          </div>

          <div className="gesture-legend">
            <span>
              <i className="swatch hand" /> Hand
            </span>
            <span>
              <i className="swatch face" /> Face
            </span>
            <span>
              <i className="swatch pointer" /> Pointer
            </span>
            {status?.handVisible ? (
              <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>
                conf {status.confidence.toFixed(2)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="card">
          <h2>
            Gesture identification
            <span className="sub">
              {status ? (status.armed ? 'Armed' : 'Not armed') : 'No reading'}
            </span>
          </h2>

          <div className="gesture-labels" aria-live="polite">
            {labels.length > 0 ? (
              labels.map((label) => (
                <span key={label.text} className={`badge ${label.tone === 'plain' ? '' : label.tone}`}>
                  {label.text}
                </span>
              ))
            ) : (
              <span className="badge">—</span>
            )}
          </div>

          <table className="simple" style={{ marginTop: 14 }}>
            <tbody>
              <tr>
                <td>Phase</td>
                <td className="mono">{status?.phase ?? '—'}</td>
              </tr>
              <tr>
                <td>Reason</td>
                <td className="mono">{status?.reason || '—'}</td>
              </tr>
              <tr>
                <td>Finger curl</td>
                <td className="mono">{status ? status.curl.toFixed(2) : '—'}</td>
              </tr>
              <tr>
                <td>Finger curls (2D)</td>
                <td className="mono">
                  {status?.fingerCurls?.length
                    ? status.fingerCurls.map((c) => c.toFixed(2)).join(' / ')
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Finger curls (3D)</td>
                <td className="mono">
                  {status?.fingerCurls3d?.length
                    ? status.fingerCurls3d.map((c) => c.toFixed(2)).join(' / ')
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Hand → mouth</td>
                <td className="mono">{status?.distance != null ? status.distance.toFixed(2) : '—'}</td>
              </tr>
              <tr>
                <td>Pinch distance</td>
                <td className="mono">{status?.pinchDistance != null ? status.pinchDistance.toFixed(2) : '—'}</td>
              </tr>
              <tr>
                <td>Pointer</td>
                <td className="mono">
                  {status?.pointer
                    ? `${status.pointer[0].toFixed(2)}, ${status.pointer[1].toFixed(2)}`
                    : '—'}
                  {status?.pointerReason ? ` · ${status.pointerReason}` : ''}
                </td>
              </tr>
              <tr>
                <td>System pointer</td>
                <td className="mono">
                  {systemPointer ? 'on · real Windows cursor' : 'off · in-app overlay only'}
                </td>
              </tr>
              <tr>
                <td>Tracking hand</td>
                <td className="mono">
                  {status?.handLabel
                    ? status.handLabel === 'Right' || status.calibrated
                      ? status.handLabel.toLowerCase()
                      : `${status.handLabel.toLowerCase()} (right preferred)`
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Pointer centre</td>
                <td className="mono">
                  {status ? (status.calibrated ? 'set' : 'not set — press Centre cursor') : '—'}
                </td>
              </tr>
              <tr>
                <td>Palm position</td>
                <td className="mono">
                  {status?.palm
                    ? `${status.palm[0].toFixed(2)}, ${status.palm[1].toFixed(2)}`
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Palm facing</td>
                <td className="mono">
                  {status?.ray
                    ? `${status.ray.normal[0].toFixed(2)}, ${status.ray.normal[1].toFixed(2)}, ${status.ray.normal[2].toFixed(2)}`
                    : '—'}
                </td>
              </tr>
              <tr>
                <td>Gaze target</td>
                <td className="mono">
                  {status?.gaze?.target === 'tablet'
                    ? 'iPad'
                    : status?.gaze?.target === 'laptop'
                      ? 'laptop'
                      : status?.gaze?.yaw != null
                        ? 'between (holding last)'
                        : '—'}
                  {status?.gaze?.yaw != null ? ` · ${status.gaze.yaw.toFixed(1)}°` : ''}
                </td>
              </tr>
              <tr>
                <td>Gaze routing</td>
                <td className="mono">
                  {status?.gaze?.mode === 'calibrated'
                    ? status.gaze.laptopYaw != null && status.gaze.tabletYaw != null
                      ? `calibrated · laptop ${status.gaze.laptopYaw.toFixed(0)}° / iPad ${status.gaze.tabletYaw.toFixed(0)}°`
                      : 'calibrated'
                    : status?.gaze?.mode === 'invalid'
                      ? 'invalid anchors — look at each screen again'
                      : status?.gaze
                        ? 'default · face the laptop, or turn away for the iPad'
                        : '—'}
                </td>
              </tr>
              <tr>
                <td>Hand / face</td>
                <td className="mono">
                  {status ? `${status.handVisible ? 'yes' : 'no'} / ${status.faceVisible ? 'yes' : 'no'}` : '—'}
                </td>
              </tr>
              <tr>
                <td>Frames</td>
                <td className="mono">{status?.frames ?? 0}</td>
              </tr>
              <tr>
                <td>Camera brightness</td>
                <td className="mono">
                  {status && status.cameraMean >= 0
                    ? `${status.cameraMean.toFixed(0)}/255${status.cameraDark ? ' — black' : ''}`
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>

          <h2 style={{ marginTop: 18 }}>Last gesture</h2>
          {lastEvent ? (
            <div className="mono" style={{ color: 'var(--text-dim)' }}>
              <span className="badge accent">{lastEvent.kind}</span> {lastEvent.message}
            </div>
          ) : (
            <div className="empty" style={{ padding: '10px 0' }}>
              No gesture detected yet.
            </div>
          )}

          {status?.error ? <div className="banner bad" style={{ marginTop: 14 }}>{status.error}</div> : null}
        </div>
      </div>
    </>
  );
}
