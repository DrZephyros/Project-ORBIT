# ORBIT

Windows workspace broadcast to an iPad, built from `Outline.txt`.

The plan calls for three modes — Workspace, Assistant, Operator. This build
implements **Stage 0 and Stage 1** of the roadmap, which is the part everything
else depends on:

- a secure local pairing flow between the Windows app and an iPad in Safari,
- selection and broadcast of a single window,
- touch-driven arrangement of panels on the iPad,
- immediate cancellation, revocation and session teardown.

Assistant, gesture and operator stages are scaffolded with the safety boundary in
place, but not enabled. The UI says so rather than showing dead controls.

## Layout

```
packages/
  shared/     Wire protocol and the permission policy (no runtime deps)
  server/     Local signalling server + receiver hosting
  desktop/    Electron app (main + preload + React renderer)
  receiver/   iPad-side web app served at /r
```

## Run it

First time only:

```bash
npm install
pip install mediapipe opencv-python websockets
```

Then, every time:

```bash
npm start
```

Or double-click **`start.cmd`** in Windows Explorer.

That single command starts the signalling server and the desktop app together.
It checks dependencies, picks the Python interpreter that actually has MediaPipe
installed, rebuilds only if sources changed, frees ports left behind by an
earlier run, and shuts everything down on Ctrl+C.

Useful variants:

| Command | What it does |
|---|---|
| `npm start` | build if needed, then run everything |
| `npm run start:fast` | skip the build check — fastest restart |
| `npm run start:gestures` | skip the server; camera and gestures only |
| `npm run check` | run the preflight checks and exit |

Only one ORBIT can run at a time; a second launch says so instead of taking over
the ports.

### Doing it by hand (three terminals)

Still supported if you want to watch each part:

```bash
npm run dev:server     # signalling server + receiver host (port 8787)
npm run dev:receiver   # receiver dev server (port 5174, proxies /ws to 8787)
npm run dev:desktop    # Electron app
```

For a realistic test, build the receiver and let the server serve it, then open
`https://<laptop-ip>:8787/r` on the iPad:

```bash
npm run build -w @orbit/receiver
npm run dev:server
```

The server runs **HTTPS** by default. iOS Safari only exposes `RTCPeerConnection`
and `crypto.randomUUID` in a secure context, and a LAN IP over plain `http://` is
not one, so the receiver would load but never pair or show video. ORBIT generates
a small local **certificate authority** and a server certificate signed by it,
stores both in `%USERPROFILE%\.orbit`, and reuses them. The server certificate is
re-signed automatically when the laptop's LAN address changes, so the iPad keeps
trusting the CA.

Safari may load the page after the usual certificate warning and still refuse the
`wss://` socket, which looks like **“Cannot reach the laptop”** even though the
page is open. If that happens, open `http://<laptop-ip>:8788/cert` on the iPad,
install the profile, then enable it in **Settings → General → About → Certificate
Trust Settings → ORBIT Local CA**. The pairing screen also offers an **Install
certificate** button when it cannot connect. Set `ORBIT_NO_TLS=1` to force plain
HTTP for desktop-only debugging.

**Windows must allow both ports.** The first time, run this in an Administrator
terminal, or the iPad gets a timeout instead of a page:

```powershell
netsh advfirewall firewall add rule name="ORBIT 8787" dir=in action=allow protocol=TCP localport=8787 profile=private
netsh advfirewall firewall add rule name="ORBIT 8788" dir=in action=allow protocol=TCP localport=8788 profile=private
```

`npm run check` reports this for you if the rule is missing.

Electron's postinstall is blocked by npm's script policy in this environment. If
the app will not launch, approve it once:

```bash
npm approve-scripts electron
```

## How pairing works

1. The desktop connects and asks for a session.
2. The server issues a **6-digit code** valid for 5 minutes and **single use**.
3. The code is shown in the app and rendered into a local QR code (`#c=code`).
4. The iPad enters or prefills the code and sends `receiver.hello`.
5. On success the code is **burned and rotated**, so a bystander who saw it
   cannot reuse it.
6. Five wrong attempts lock the code; a new one must be issued on the laptop.
7. A reconnect from the same iPad resumes by its stable device id, because the
   single-use code it joined with is gone. This includes a page reload: a paired
   flag stored next to the device id lets it reconnect without a code, and the
   receiver shows its standby clock while it tries. A desktop socket reconnect
   reuses the session and the still-live code instead of replacing them.

The QR code is read once, before the receiver opens its socket, so scanning
joins immediately and cannot race a second connection. Codes are stored hashed
and compared in constant time, and the QR is generated in the main process, so
no third-party QR service sees the address or the code.

## Security posture

These are enforced in code, not just described:

- **Single-window capture only.** The main process authorises exactly one
  `window:` source id per `getDisplayMedia` call, the grant expires after 30s,
  and `screen:` (whole desktop) is refused.
- **No renderer escape hatch.** The preload exposes a fixed set of IPC methods
  and a fixed list of event channels. No generic `ipcRenderer.send`.
- **CSP and navigation lock.** The renderer ships a Content-Security-Policy, and
  the window cannot navigate away from itself; external links go to the system
  browser.
- **Permission policy in one table** (`packages/shared/src/policy.ts`). Deletion,
  credentials, banking, private mail and shell access are `blocked`, not
  configurable. Coding edits are `needs-approval`. Anything unclassified is
  blocked.
- **No cloud AI call** is made anywhere in this build. There is no model
  provider wired up, so nothing can leak to a third party.
- **Sessions expire** after 8 hours, and idle receivers are dropped after 90s.

## Tests

The protocol is covered end to end against the real server and real sockets:

```bash
npm run build -w @orbit/server
node packages/server/test/pairing.test.mjs
```

Covers: health, welcome + code issuance, wrong code rejection, join, code
burning, source relay, offer/answer relay, ICE both directions, hand-pointer and
pinch-click relay, panel action relay, malformed and unknown message handling,
receiver resume without a code, desktop reconnect without losing the session,
revocation, and session end.

Gesture logic is deterministic and separate from the camera:

```bash
python services/gestures/tests/test_gesture.py
```

## What is not built yet

Honest status, matching the roadmap:

| Stage | State |
|---|---|
| 0. Hardware validation | Pairing, hosting and one-to-one stream negotiation work. Verified on the local network with two clients; **not yet verified with a real iPad and a mouse-driven window selection on this machine**. |
| 1. Core session | Done: pairing, single-window broadcast, Stop, revoke, reconnect with backoff. |
| 2. Workspace | Move/resize on iPad touch with bounds clamping; Arrange vs Interact modes. |
| 3. Gesture control | **Right-hand pointer, pinch click/hold-drag, three-finger scroll, fist window drag and gaze routing work end to end** (camera -> MediaPipe -> state machine -> Windows). The right hand moves the real cursor; a pinch is a real mouse-down until the fingers open; thumb + index + middle turn the wheel of the window under the pointer; a held right fist moves the foreground window, and a left fist swept sideways switches virtual desktops. Releasing while looking at the iPad still hands the panel over. Dictation is simulated on purpose. Thresholds are not tuned against real room lighting yet. |
| 4. Dictation | Not enabled. UI documents the two modes and the mic lifecycle. |
| 5. Assistant | Not enabled. Local command routing is stubbed for `broadcast`. |
| 6. Browser operator | Not started. |
| 7. Native operation | Not started. |
| 8. Coding agent | Not started. |
| 9. Advanced content | Not started. |
| 10. Hardening / TV | Not started. |

### iPad shows a black or blank page

The receiver app itself is fine if it works on the laptop. A blank page on the
iPad is almost always the connection, not the app. Check in this order:

1. **Same Wi-Fi.** The iPad and laptop must be on the same network; guest
   networks and "client isolation" block device-to-device traffic.
2. **Windows Firewall.** Your Wi-Fi is usually marked *Public* on Windows, which
   blocks inbound connections by default, so the iPad cannot reach port 8787 even
   though the address works on the laptop. Allow the port once, scoped to your
   local subnet, from an elevated PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "ORBIT receiver (8787)" `
     -Direction Inbound -Protocol TCP -LocalPort 8787 `
     -RemoteAddress LocalSubnet -Action Allow
   ```

   Remove it with `Remove-NetFirewallRule -DisplayName "ORBIT receiver (8787)"`.
3. **The certificate.** ORBIT serves HTTPS with a certificate from its own local
   CA. Safari warns the first time; tap **Show Details → visit this website**. If
   the page opens but the app says it cannot reach the laptop, Safari is blocking
   the WebSocket upgrade: open `http://<laptop-ip>:8788/cert` on the iPad, install
   the profile, and enable it under **Settings → General → About → Certificate
   Trust Settings**. Plain `http://<laptop-ip>:8787/r` will load the shell but
   cannot pair or stream, because iOS blocks WebRTC outside a secure context.
4. **Confirm the laptop side.** On the laptop, `curl <the printed iPad URL>`
   should return the page. If that works locally but not from the iPad, it is the
   network or firewall, not ORBIT.

### ORBIT froze, or a gesture stopped responding

Open the log before restarting. It is written continuously and survives a hard
kill:

```
%APPDATA%\@orbit\desktop\orbit\logs\orbit.log
```

The **Gestures → Open logs** button opens that folder. Every line is timestamped.
Read it from the bottom up:

- `WARN freeze: main process event loop was blocked for N ms` — the UI stalled
  for N milliseconds and the app knows it. Whatever is logged just above is what
  was running.
- `DEBUG heartbeat: alive` once a minute, with loop lag and memory. If the file
  simply stops after a heartbeat, the process died or was killed at that moment.
- `ERROR crash`, `window: Renderer gone`, `gestures: Gesture service exited` —
  the app (or one of its children) restarted or failed, and why.

The log rotates at 4 MB and keeps two previous files (`orbit.log.1`, `.2`).

### Devlog

Design decisions, bugs found and what was actually verified are recorded in
[`DEVLOG.md`](./DEVLOG.md).

### Known gaps

- **Implemented gestures: cup-at-mouth (simulated dictation), pointer, pinch
  click / hold-drag, three-finger scroll, fist window drag.** The service still
  flags a fast pinch release as `window.throw`, but nothing uses that for
  movement any more: gaze decides where a released window goes, so a throw cannot
  move a panel by accident. The rest of the plan's vocabulary (swipe, broadcast
  push) is not implemented. The plan warns against shipping gestures just because
  a model can occasionally recognise them.
- **Only the right hand controls the pointer.** A lone left hand is ignored, so
  putting the wrong hand up does nothing rather than taking over the cursor.
- **The gesture pointer moves the real Windows cursor** while the laptop owns
  control, a right hand is in frame and `systemPointer` is on. It is withheld
  while the head is turned to the iPad, and while a three-finger scroll is
  active, so the page under the hand stays still. Turning the preference off
  leaves the physical mouse completely untouched.
- **Gaze routing needs both anchors.** Look at the laptop and press *Look at
  laptop*, then look at the iPad and press *Look at iPad*. Until both exist, a
  release leaves the window where it is. If the anchors are too close together
  it refuses to save them rather than guessing.
- **A throw does not move a window.** `window.throw` is still detected and unit-
  tested at the gesture layer, but the desktop ignores it. Direction-based
  routing would fire on the release of a pinch click, which is now a selection,
  not a transfer.
- **Dictation is simulated.** No microphone, no transcription; it emits messages.
- **Grabbing moves a real Windows window.** Holding a fist in front of the
  camera grabs the foreground window (ORBIT's own window is skipped) and moves it
  with the hand; lowering the fist lets go after a 300 ms grace so a dropped frame
  does not end the drag. Releasing while looking at the iPad still stages the
  panel for the gaze-directed handoff. The wheel follows the window under the
  cursor, not the focused window, because while you watch the Gestures page the
  focused window is ORBIT.
- **Thresholds are geometric, not empirical.** Curl 0.55, the 0.75/1.15 face-width
  bands, pinch 0.50/0.68, a 0.035-screen-height wheel step, throw speed 0.9
  screen-widths/s (event only), and the 600/450/300/400/60 ms holds are reasoned
  defaults, not values measured on your face, lighting and posture. Expect to
  tune them. See `DEVLOG.md` for the reasoning.
- **Screenshot preview of the panel on the iPad** relies on the WebRTC video
  element. The desktop canvas shows position and size but deliberately does not
  mirror the video, to avoid doubling encoder load.
- **HTTPS uses a local CA, not a public one.** The iPad can accept the Safari
  warning, or install the CA from `/cert` for a warning-free connection. Traffic
  is encrypted either way, but the certificate is not issued by a public CA. Plain
  HTTP is only available with `ORBIT_NO_TLS=1` for desktop debugging.
- **Encoding cost** of two simultaneous windows has not been measured.
- **Diagonostics page** reports what it can observe; frame drops, latency and
  quota state are marked as unmeasured rather than shown green.
