# ORBIT devlog

A running record of what changed, why, what broke, and what was actually
verified. Written to be honest about the difference between "compiles" and
"works on the hardware".

Newest entries first.

---

## 2026-11-17 (forty-first pass) — the iPad was answering for the laptop

**Scope:** `packages/desktop`, `packages/receiver`, `services/gestures`

Reported, in one message: laptop cursor movement is "way worse", window dragging
is "VERY glitchy", desktop switching "still doesn't work", and the left hand needs
a visual indicator again. Only the iPad was supposed to change.

### Both regressions had one cause

The iPad's gaze opinion was being checked *before* the laptop's own. That ordering
was introduced to make the transfer reliable, and it is wrong for everything else:
the iPad sits on a stand in front of the user, so its camera sees a face for the
whole session. Once it said "looking at the tablet", every pointer frame was
routed to the tablet - `releaseOsPointer()` and `endWindowDrag()` ran on it, and
the cursor stopped following the hand for as long as the state lasted. That is
the cursor feeling worse and the drag breaking up, in one line of precedence.

The laptop's own router measures the head from the laptop camera on every frame,
so it now decides whenever it has an opinion. The iPad is a witness that speaks
only when the laptop camera has no face at all - which is exactly the moment the
transfer depends on. The same ordering was applied to `currentOwner()`, which had
been silently dropping dictation.

The gaze settle (`GAZE_SETTLE_MS`) also only applies while a window is carried
now. It exists so a glance at the iPad cannot drop a window mid-drag; applying it
to the cursor made the pointer ignore the hand for a third of a second at a time.

### Desktop switching: the service saw the hand and threw the swipe away

The new log line answered it in one gesture:

```
left hand closed
left hand open            (108 ms later)
```

No `desktop.switch`, ever. The fist detector is not stable frame to frame, and
the swipe anchor was cleared on the first open frame - so a 108 ms flicker reset
the travel before it could add up to the one step (0.12) a switch needs. The
gesture was being recognised and discarded on the same arm movement.

An open hand now has a 260 ms grace before the swipe is considered released, and
a hand that comes back *somewhere else* (more than 0.06 away) is treated as a new
sweep rather than a flicker. Both cases are tested.

Also: a left-fist slide is ignored entirely while a window is held. A resting left
hand switching desktops mid-drag teleports the window to another desktop and
strands ORBIT there - the "very glitchy" complaint would have looked exactly like
that if it ever fired.

### The indicator, and why it never appeared

`gesture-hud.ts` is a new click-through, never-focused overlay at the bottom of the
primary display: it says "LEFT HAND CLOSED" while the hand is closed, fills a bar
as the slide progresses, and flashes "DESKTOP LEFT" / "NEXT WINDOW" when something
actually happens. It shows the slide, not just the result, because the gesture is
continuous.

It was invisible for a plain reason: `normaliseStatus` in `gestures.ts` whitelists
every field it forwards, and `leftFist` and `deskProgress` were not on the list.
The service was sending them; the desktop was dropping them. Both are now passed
through, along with their types, so the renderer can use them too.

### Verified

- gesture tests 282 passed, 0 failed (new: a flickering fist still completes its
  sweep).
- `npm run typecheck`, `npm run build` clean; ORBIT restarted on the new build.
- Real log evidence for the diagnosis: `left hand closed` / `left hand open`, and
  no `desktop.switch` line at all before this pass.
- The overlay page's inline script parses (extracted from source and compiled).

**Not verified:** the overlay on screen. `tools/hud-smoke.mjs` launches Electron
to create it and report what it displays, but Electron here writes nothing to the
console and the run timed out, so the page has been syntax-checked and not looked
at. The desktop switch itself also needs a real left hand to confirm end to end.

---

## 2026-11-16 (fortieth pass) — the window on the iPad is a window, not a picture of one

**Scope:** `packages/shared`, `packages/server`, `packages/desktop`,
`packages/receiver`

Reported: "on the iPad, the cursor should be controlled by right hand only...
left should only be for window switching", and "when I transfer a window, all
controls to that window must be available on the iPad - the onscreen keyboard
must type into it, and my hand must control a working cursor, not a dummy one".

### The cursor was real; it just had nothing to operate

The iPad already drew a cursor and turned a pinch into DOM events at that point
on the page. On ORBIT's own UI that is correct - it presses ORBIT's buttons. On a
transferred window it was theatre: the window is running on the laptop, and no
DOM event on a `<video>` reaches it. So the pinch clicked a picture.

Remote input is now a typed message, exactly like the eye tracking: a position as
a *fraction of the panel*, a `move`/`down`/`up`, and a keystroke. The desktop
maps the fraction onto the real window's bounds - read fresh from the helper for
every event, because the window can be moved by the laptop user at any moment -
and drives the Windows cursor there with the same `SetCursorPos`/`mouse_event`
the hand already used. `receiver.remote.pointer`, `receiver.remote.key` in;
`server.remote.pointer`, `server.remote.key` out to the desktop.

The drawn cursor stays. It is not a substitute any more, it is the low-latency
copy: a captured window does not contain the Windows pointer, and the video is a
round trip behind the hand, so without the dot the user would aim blind for about
a tenth of a second.

### The window it controls is named, not guessed

The renderer reports `panelId -> hwnd` when it hands a window over, using the
handle the fist actually grabbed (`orbit:ev-grab-target`). Without that mapping
the only options were "the frontmost window", which is wrong the moment the user
touches the laptop, or "whatever the cursor was over", which is wrong the moment
the iPad moves it.

The hand-off event also carries that handle now, so the renderer sends the window
that left the laptop rather than "the held panel, or the selected one" - a stale
selection could previously send a different window than the one in the hand.

### Typing

A soft keyboard has no field to type into when the thing on screen is a laptop
window, so the iPad's keyboard is pointed at it: a hidden-but-focusable textarea
(iOS will not raise the keyboard for a `display: none` field) behind a small
"Keyboard" button, one message per keystroke. Named keys go as keys; everything
else goes as text. The helper types with unicode `SendInput` in a single call per
message - not per character, because the helper reads commands on the same thread
that would be sleeping between characters and every pointer move queued behind
it.

Two details worth keeping:

- The native `INPUT` struct is 40 bytes on x64 with the union at offset 8. It is
  declared `Explicit` with `Size = 40`, and the helper measures it at startup and
  complains on stderr if it is wrong, because a wrong `cbSize` makes `SendInput`
  reject every keystroke in silence.
- Before typing, the window is brought to the foreground. A keystroke has no
  position, so unlike a click there is nothing telling the shell which window it
  was meant for, and typing into the wrong application is worse than not typing.

### One hand each

The receiver asked MediaPipe for one hand and used it for everything, so a paging
sweep also dragged the cursor and a pinch could be read as the start of a page
turn. It asks for two now, and uses the handedness label: the right hand is the
pointer, the left hand only pages. The label drops for a frame or two when a hand
is half out of shot, so the chosen index is sticky rather than re-decided every
frame. If no label is reported at all (an older build), the first unclaimed hand
is the pointer, as before.

### Routing the rest by gaze

- A left-fist swipe already chose desktops or cast windows by gaze; when the iPad
  is not reporting at all it now falls back to the service's live router instead
  of assuming the laptop.
- Scrolling used to be dropped entirely while looking at the iPad. It is not
  dropped any more if the iPad is actually steering a window on the laptop: the
  wheel goes to whatever is under the cursor, and the cursor is on that window.

### A window can no longer leave without a gesture

Completing a transfer needed a fist to open while the head was on the iPad. But
an iPad that has just started tracking reports an *open* hand on its first frame,
which is a camera warming up, not a release - so looking over at the iPad while
carrying could send the window on its own. The tablet's fist must now be seen
closed at least once during the carry before an open hand counts.

### Verified

- `services/gestures/tests/test_gesture.py` - 281 passed, 0 failed.
- `packages/server/test/pairing.test.mjs` - 18 passed, 0 failed, including two
  new cases: the remote pointer/key envelopes cross the relay intact, and a
  position outside the panel is clamped rather than dropped.
- `tools/helper-probe.mjs` (new) extracts the PowerShell/C# helper from the built
  output and drives it over stdin: `READY`, `G 0` returns a window with bounds,
  `B` answers `BOUNDS <hwnd> 0 0 1536 864`, `F` and `Y` do not throw. The INPUT
  size check reports nothing, so the struct is 40 bytes.
- `npm run typecheck`, `npm run build` clean.

**Not verified:** the whole loop on real hardware - an iPad pinch moving the
laptop cursor on a transferred window, and the on-screen keyboard typing into it.
The messages, the mapping, the cursor placement and the typing are each exercised
separately; nobody has yet put a hand in front of an iPad and watched a remote
window respond.

---

## 2026-11-16 (thirty-ninth pass) — a swipe that means two things, a drag that keeps going

Five requests in one go: more pointer sensitivity on the iPad, windows that fill
it, a left-fist swipe to page between cast windows, desktop switching on the
laptop, and a window drag that does not stop half way.

**1. iPad pointer sensitivity.** The laptop moves its cursor at
`POINTER_POSITION_GAIN_X/Y = 3.5/3.8` screen fractions per face width; the iPad's
own tracker was at `GAIN_X/Y = 1.4/1.5`, so it needed better than twice the hand
travel for the same distance. Matched to the laptop's pair (3.1/3.4 - slightly
lower on X because the iPad is held closer, so the same sweep covers more of its
frame). `SMOOTHING` dropped 0.6 -> 0.45 and `DEAD_ZONE` 0.014 -> 0.009 in step:
amplification multiplies a dead zone into a sticky patch in the middle of the
screen, and smooths a fast movement into lag. `MAX_JUMP` raised to 0.95, because
at 3.1x an ordinary deliberate sweep looks like a tracker glitch to a governor
tuned for 1.4x.

**2. Windows fill the iPad.** The workspace bar and footer were spending ~95 px
of a 768 px tall screen on chrome, so a "full screen" window was not one. In the
solo layout both are hidden, the canvas is black, and the two things that have to
stay reachable - which window this is, and how to send it back - float in a faded
strip over the top edge that brightens on touch. Measured: panel 1024x768 in a
1024x768 viewport, fill ratio 1.0 on both axes, no card border or radius.

**3. Two functions, one gesture.** A four-finger trackpad swipe means "slide to
the next screen in that direction". Which screens those are depends on where the
head is pointing, and now both are wired to the same left-fist motion:

- Looking at the laptop -> `systemPointer.switchDesktop()`, as before.
- Looking at the iPad  -> `EV.cyclePanel`, and the desktop renderer selects the
  next window that has an owner device. It wraps, so the gesture never
  dead-ends.

The witness is the iPad's own gaze (`tabletGazeFresh()`), never
`lastPointer.gaze`: once the head turns to the tablet the laptop's webcam loses
the face, so only the tablet can still say where the user is looking.

Two more paths page windows, because a gesture that only works when one camera
happens to see the hand is a gesture that does not work:

- The iPad's own tracker: a closed hand swept sideways (`onSwipe`, 0.12 of the
  frame, 400 ms cooldown, vertical drift rejected) pages the windows it holds.
- A finger swipe on the glass: 60 px, mostly horizontal.

**4. The desktop swipe never fired at all.** Asked to fix "changing between
desktops when I am looking at the laptop does not work"; there was no
`Desktop switch` line in the log, so the gesture was never reaching the app. The
left hand was being classified by the *right* hand's grab detector, which only
calls a hand "in front" between 1.15 and 3.5 face widths from the mouth - and a
hand held out to the side, which is where a swipe begins, is outside that band.
`left_fist_closed()` asks the only question the left hand needs to answer: is it
closed. The band arithmetic is not information for a hand that never points,
pinches or grabs.

**5. A drag that stops half way.** Reported as "moving windows with the right
fist works but it is not continuous". Two causes, both fixed:

- The fist had to stay inside the *pickup* band to keep the grab. Dragging sweeps
  the hand across the body, so the distance from the mouth grows; past 3.5 face
  widths the fist stopped reading as "in front", the grab was released after its
  grace window, and the window stopped following - once per half screen.
  `detect_fist(held=True)` lifts the far edge while a grab exists: the only
  release worth making is the hand opening or returning to the mouth.
- Any single pointer frame decided as 'tablet' ended the physical drag. One frame
  of head movement, or the iPad's tracker saying "looking" while the user glanced
  at it, stopped the window dead. The gaze now has to stay on the tablet for
  `GAZE_SETTLE_MS` = 320 ms before it can take the window away: deliberate
  hand-offs still work, glances no longer do.

**Tested:** `281 passed` gesture tests (three new: a held grab survives a wide
sweep, a left hand out wide is recognised as a swipe, and a left fist held out
wide walks desktops), `16 passed` pairing tests, `npm run typecheck` and
`npm run build` clean, receiver layout screenshot measured and looked at.

**Not verified:** all of it on real hardware - a hand sweeping for real, a real
iPad decode, and the sensitivity numbers, which are a judgement call from the
laptop's tuned pair rather than from this session's hand.

---

## 2026-11-16 (thirty-eighth pass) — the window that was never the window, and a cast that fills the screen

Reported: "when I put a window on my iPad it wasn't the window. It was just a
small black rectangle with the title 'Status', and nothing I cast ever showed
up."

Two separate faults, and the second one was making the first look like a
rendering bug.

**1. The window that was grabbed was not the window that was captured.**

`window.grab` came out of the gesture service with no idea *which* window it
meant, so the renderer picked one itself: `sources[0]`, on the theory that
`desktopCapturer` lists windows in z-order, frontmost first. That theory is
right, and it is exactly the problem - a hidden helper window belonging to
another app (`Wispr Flow`, titled "Status") sits at the front of that list with
a real, non-zero thumbnail and **no pixels at all**. It therefore passed the
existing filter, won the race, captured as pure black, and was handed to the
iPad under its own name. Hence a small black window called "Status".

Probed it directly rather than guessing: a standalone Electron script printed
every source with a mean thumbnail brightness.

    "Status"           id=window:66504:0     thumb 158x200   b=0
    "Google Gemini …"  id=window:1575834:0   thumb 320x171   b=29

`Get-Process` confirmed the process and the title. So:

- `requestSources` now rejects a source whose thumbnail is uniformly black
  (`thumbnailBrightness() <= 2`). A window with no surface is not offered as
  something to grab or cast.
- More importantly, the *decision* moved to the only place that knows the
  answer. The PowerShell helper already returns the HWND it grabbed, and a
  capture source id is `window:<decimal HWND>:<n>` - verified by comparing
  `GetForegroundWindow()` (1575834) with the source id above. `resolveGrabSource()`
  matches on that handle and emits `orbit:ev-grab-target`, so the renderer is
  told which window to capture instead of guessing. The black-thumbnail filter
  is deliberately not applied to an exact handle match: a window that is
  momentarily black is still the window the user grabbed.

The panel is now created from that reply, not from `window.grab`, so the source
is resolved before anything is streamed. Grabbing with the system pointer off
also resolves now - it skips only the physical drag (`windowDrag.pinned`), not
the capture.

**2. It really was small, too.**

A single panel was still drawn at workspace-canvas scale: a 1024x768 logical
space, with new panels at 55% x 50% of it. With one window on an iPad there is
nothing to arrange, so the receiver now draws a lone panel **full-bleed** at
viewport size (`Workspace`'s `solo` branch, `.canvas-solo`), with the card
border, radius and shadow removed. A second panel brings the arrange canvas
back.

**Verified, not assumed:**

- `tools/cast-preview.mjs` runs the real pipeline end to end - enumerate, capture
  with the same constraints `useSenders` uses, negotiate sender and receiver peer
  connections in one process, decode, then measure the decoded frame's mean
  brightness. Result: `video 1920x1020`, both connections `connected`,
  `brightness 30` (matching the source thumbnail), `framesDecoded 2` - real
  pixels over real WebRTC. Casting works when the source is right.
- `tools/hwnd-probe.mjs` plus `GetForegroundWindow()` confirmed the
  HWND -> source-id mapping the fix depends on.
- `npm run typecheck` and `npm run build` clean; `272 passed` gesture tests;
  `16 passed` pairing tests.

**Also changed:** the receiver no longer calls a stream live merely because a
track was negotiated. `awaitFirstFrame()` waits for `framesDecoded > 0` (with a
6 s give-up for older Safari), so a sender that never produces pixels shows the
status overlay instead of an unexplained black rectangle.

**Not verified:** a real iPad receiving the window. The pieces on both ends are
tested and the wire path is unchanged, but the last metre needs the hardware.

---

## 2026-11-16 (thirty-seventh pass) — a pairing code you can actually renew

Reported: "when a code expires there is no way to get a new one."

Correct, and it was structural. A pairing code is six digits, single use and
good for `PAIRING_TTL_MS` = **5 minutes**. The server only ever *pushed* a code -
on `desktop.hello`, on `desktop.session.start`, and when a receiver was rejected -
and there was no client message that asked for one. So the Setup page's countdown
ran down to `0:00` and stopped there: dead code, dead QR, no button, and the only
way to pair afterwards was to restart ORBIT so `desktop.hello` ran again.

Three pieces, smallest first:

1. `desktop.pairing.request` (client -> server) rotates the code and answers with
   `server.pairing`, which every existing listener already handles.
2. `IPC.newPairingCode` gives the renderer a way to ask: client -> `requestPairing()`
   -> hub -> `server.pairing` -> the normal status push.
3. The Setup page now has a **New code** button next to Copy/Open, and re-fetches
   on its own the moment the countdown reaches zero. The meta line says
   "This code has expired. A new one is being issued — or press "New code"."
   instead of silently counting to zero, and a failed request says so.

Two things the first attempt got wrong, both caught by the new test:

- **The hub has an explicit `KNOWN_TYPES` allowlist** in front of `route()`. My
  first handler was unreachable: the server answered "Unknown message type." and
  the test timed out. Adding the type to the set is the actual gate.
- **A one-second "debounce" that returned the *existing* code.** It looked
  defensive and made the button appear broken: press "New code" within a second
  of a rotation and you get the same code back. Since the page only asks once per
  expiry, there is no loop to protect against, so a request now always rotates.

Verified with a new case in `packages/server/test/pairing.test.mjs` (real server,
real sockets):

```
ok   the desktop can ask for a replacement code when one expires
```

which asserts the replacement is six digits, differs from the dead one, has a
live `expiresAt`, carries the new code in its QR payload - and that the *old* code
is genuinely rejected, so a stale QR fails loudly instead of pairing the wrong
session. `16 passed, 0 failed`; `npm run typecheck` and `npm run build` clean. Not
verified in the running app: it needs a restart, and a five minute wait for a real
countdown to hit zero.

---

## 2026-11-16 (thirty-sixth pass) — a ring around the window you are holding

A grab was invisible. The window moved, so *something* was happening, but the app
never showed that a carry was live, which window it had, or that opening the hand
was the confirmation. Request: "an indicator on the laptop when it detects that I
grabbed a window. Something cool that is visible when I am on the grabbed
window."

So the indicator is not in ORBIT's panel. While a window is being carried the eyes
are on that window, and ORBIT is usually behind it, so a banner in the app would be
seen only by someone who did not need it. Instead there is a second window:
transparent, frameless, click-through, always-on-top, sized to the grabbed window
plus 22 px of padding so the glow has somewhere to spill. Everything is drawn in
that padding or as a rim - the overlay sits on another application's pixels, and
filling the middle would hide the thing being carried.

`packages/desktop/src/main/carry-indicator.ts`, driven from `ipc.ts`:

| moment | what is on screen |
| --- | --- |
| `window.grab`, helper replies with the window rect | cyan → violet ring, pulsing corner brackets, badge **WINDOW GRABBED** / "drag to move · look at the iPad, then open your hand" |
| the head turns to the iPad (`tabletGaze` looking, carry still held) | ring and badge turn violet, **READY TO SEND** / "open your hand to hand it to the iPad", glow breathes faster |
| the carry completes (`handOffToTablet`) | flash of mint green, **SENT TO IPAD**, one expanding burst, gone in 0.95 s |
| released with nowhere to go, reset, disarm, 30 s timeout | grey **LET GO**, fades in 0.38 s |

Geometry is carried by the overlay window itself: `move()` calls `setBounds` with
the same coordinates `systemPointer.moveWindow` just sent, so the ring cannot drift
from the window while it is being dragged. State changes are the only thing pushed
into the page (`executeJavaScript`, a few per carry, never per frame).

Details that are not incidental:

- **`focusable: false` + `showInactive()`.** The window being carried must keep the
  foreground: the PowerShell helper picks its grab target from the foreground
  window, and a focus-stealing overlay would re-target the very grab it is drawing.
- **Singleton + destroy on close.** `window-all-closed` quits the app, and it only
  fires when *every* window is gone. A surviving overlay would either keep a
  headless process alive after "close ORBIT" or leave a ghost ring on the desktop.
  `mainWindow.on('closed')` disposes it first; `before-quit` does too.
- **No green flash on a plain release.** `window.release` runs after
  `handOffToTablet` has already flashed "sent"; `finish('dropped')` is skipped when
  the hand-off fired, or the grey would paint over the green.

Verified with a harness, `tools/carry-preview.mjs` (dev only, in `tools/`), which
opens a mock app-like window, puts the real overlay on it, runs all four states and
captures each one:

- hold: ring hugs the window edge, badge readable, window content untouched.
- aim: violet, obviously different at a glance, all four corners accented.
- sent: mint green ring/glow, badge "SENT TO IPAD".
- dragged +130/+60: `overlay bounds {328,188,924,584}` against expected
  `{328,188,924,584}` - **ALIGNED**, exactly.

The harness also turned up something worth writing down: on this machine *every*
new `BrowserWindow` opens **maximised** - a bare frameless window reports
`{-8,-8,1552,832}, isMaximized: true` at creation, before any code touches it. That
is very likely why the close-button crash was reproducible here: a window created
for the user is maximised, so the top-right of the screen is its Close button. The
overlay is created with `show: false` and `focusable: false`, which kept it out of
that behaviour, and `place()` is now re-asserted on `did-finish-load` in case it
ever is not.

`npm run typecheck` clean, `npm run build` clean, `272 passed, 0 failed`. The
overlay was not seen during a real fist grab - that still needs the user's hand.

---

## 2026-11-16 (thirty-fifth pass) — "it crashes immediately after it boots" was a hand click on our own close button

It never crashed. It quit, cleanly, because a gesture click landed on ORBIT's own
Close button. The log says so twice:

```
15:53:23.796  ipc: Pointer press. {"x":1536,"y":0,"gaze":"laptop"}
15:53:24.274  window: Window closed.
15:53:24.289  app: All windows closed.
15:53:24.314  app: Quitting.
```

No segmentation fault, no uncaught exception, no renderer death - `window closed`
is Electron reporting a normal `close` event, so *something asked the window to
close*. `(1536, 0)` is the top-right pixel of the primary display (1920x1080 at
125% scaling). The top-right of a maximised window is its Close button, and
Windows' caption hit-test reaches into the corner. A hand cursor parked there plus
one pinch equals a quit that looks exactly like a crash.

Why was the cursor in the corner at all? Two separate reasons:

**1. The service emitted cursor positions before it had a neutral point.**
`_effective_calibration` returns `None` while it is still sampling the palm, and
`detect_pointer` reads `None` as "the middle of the camera frame is the middle of
the screen". With `POINTER_POSITION_GAIN_X/Y` of 3.5/3.8, a hand 14% of a frame
width off-centre already maps to the screen edge, so the first frames of every
session could park the OS cursor in a corner before the user had done anything.
The service now reports no hand at all until a neutral point exists, and the
desktop's pointer handler holds the cursor where it is. No coordinates, no corner.

**2. The saved calibration is from 12 November.** `services/gestures/
calibration.json` still holds a neutral point of (0.547, 0.615) - a hand resting
low in the frame. Held higher, the same mapping pins `y` to the top edge: the palm
only has to anchor above 0.483. That is why the press was at `y: 0` exactly, and
why the presses that followed - at x 1536, 1166, 941 - rode the top edge while the
hand moved sideways. A deliberate calibration wins over auto-centring by design,
so a stale one is fixed by the Calibrate button, not by code. Worth remembering:
if the cursor feels stuck against an edge, re-calibrate.

Three changes, in order of how much they matter:

- **A hand click can no longer press ORBIT's own window buttons.** `isOwnCaptionButton`
  refuses a gesture click inside the caption cluster (top 40 px, right 180 px) of
  ORBIT's window while it has focus, and logs
  `Ignored a hand click on ORBIT's own window buttons.` No gesture can minimise,
  maximise or quit the app it is driving. Other apps' title bars are unaffected.
- **No cursor before a neutral point** (above).
- **`SCREEN_EDGE_INSET` (1.5%)** keeps the outermost pixels of the screen
  unreachable by hand, so the cursor cannot sit on a resize border. The taskbar is
  48 px tall at the bottom and stays reachable. The close-button corner is handled
  by the caption guard instead of by geometry, because an inset small enough to
  keep the screen usable is too small to miss a 46 px button.

Verified: `npm run typecheck` clean, `npm run build` clean, `272 passed, 0 failed`
in the gesture suite, `serve.py` compiles, the built main bundle contains the guard,
and a replay of the logged coordinate through the new mapping gives `(1513, 13)` -
still inside the caption cluster, which is why the guard is the fix that matters.
Stack launched with the camera open and no new errors. **Not verified:** a real
hand click on a real maximised window; that needs the user at the machine.

---

## 2026-11-16 (thirty-fourth pass) — iPad tracking that survives a dropped frame, and a carry the tablet can finish

Three reports, one cause between the first two.

### "The tracking is very bad on the iPad, very glitchy, and gaze detection is not as good"

The iPad ran *both* landmarkers on every decoded camera frame, synchronously on
the main thread, and believed every single frame's result absolutely. That is
the whole report:

1. A hand model plus a full face mesh (with the transformation matrix) per
   frame, 24 times a second, on the same thread that draws the cursor and runs
   React. The cursor trailed the hand no matter how good detection was, which is
   the "not as good as the laptop" half - the laptop runs its models in a
   separate Python process.
2. No smoothing, no hysteresis, no dwell on gaze. Each 120 ms reading went
   straight out over the socket, so a single noisy angle flipped which screen
   owned control. The chip flickered; worse, the laptop's idea of where the user
   was looking flickered with it.
3. One dropped hand frame hid the cursor and released a held pinch outright.
   At 24 fps with a model that misses frames, that is a cursor that blinks and
   clicks that do not register.

What changed, all in `packages/receiver/src/lib/tablet-tracking.ts`:

* **The face is read on its own slow clock** (150 ms, six a second - head pose is
  a quarter-second signal) and the result is filtered through an exponential
  smoother with a 100 ms time constant.
* **Gaze now needs hysteresis and a dwell.** Claiming the screen needs the head
  within 22 degrees; giving it up needs 32. Between those the current answer
  stands, so a head resting on the threshold cannot oscillate. A change must
  also survive 120 ms. The first opinion of a session is taken immediately, so
  nothing waits on a dwell that has nothing to compare against.
* **A missing face is doubt, not a decision.** 600 ms of no face keeps the last
  opinion; only past that does it become `null`. Short enough that turning back
  to the laptop hands control over promptly (longer and the laptop's cursor
  looks stuck, which has been reported twice before), long enough to ride out a
  blink or a hand across the face.
* **The hand model only runs when it can matter**: while the user is facing this
  iPad (the cursor does not exist otherwise), or while a hand is believed to be
  a fist, because that is half of the carry gesture below. That roughly halves
  the per-frame main-thread cost in the common case of someone working at the
  laptop.
* **A hand missing for 260 ms no longer hides the cursor or releases a pinch**;
  the pinch gets 220 ms of grace of its own. Pending pinches are still released
  when ownership really moves, so no button is left held down by an absent hand.
* **The cursor is no longer React state.** It used to be a value set from state
  every frame, rendered through `left`/`top` with a 70 ms CSS transition - a
  re-render of the workspace 24 times a second *and* a fixed lag on top. It is
  now one DOM node positioned with `translate3d`, which the compositor handles
  off the main thread. The `.hand-cursor` CSS lost its transition accordingly.

### The window carried over to the iPad and then just stayed on the laptop

The gesture is: hold a fist while looking at the laptop, turn to the iPad, open
the hand. The transfer was wired to `window.release`, and `window.release` comes
from the **laptop's** camera. By the time the user is looking at the iPad, that
camera is pointed at the side of their head: there is no face in view, so the
service's `tracking_ok` gate never lets a gesture through at all, and the release
was never emitted. The one event the whole transfer depended on was the one the
laptop structurally could not see.

So the tablet reports it. It already computed finger curl (to keep a fist from
being read as a pinch); that answer now travels:

```
receiver.fist { fist, at }  ->  server  ->  server.fist.tablet  ->  desktop
```

and the main process treats "a fist opened while the iPad is the screen being
looked at" as the confirmation. Details that matter:

* The tablet's first report after it becomes the looked-at screen is always sent,
  even when the hand is already open. Without that, a user who opens their hand
  within a couple of frames of turning produced no event at all, because the
  tablet had never seen a fist to transition from.
* `grabHeld` is now separate from `windowDrag`. The physical Win32 move must stop
  when the head turns (the window is not on the iPad), but the *carry* has to
  survive - it is the thing being confirmed. `tabletGaze` looking at the iPad
  used to call `endWindowDrag` on the same object that recorded the carry.
* `handOffToTablet()` is the single implementation of "send it". It is now
  reachable three ways - the laptop's release, the tablet's release, and the
  old drag-past-the-edge path - and it clears the carry itself, so exactly one
  of them can fire. Previously the edge path had its own copy of the emit.
* A `gesture.reset` caused by turning to the iPad no longer cancels the carry;
  any other reset still does. A carry nobody finishes times out after 30 s.
* The renderer's carried-window preview was built from the **laptop's** gaze
  router, which reports no target the moment the face is lost - so the card
  appeared for the fraction of a second between the turn and the loss, then
  vanished exactly when the user was looking at it. It now uses the tablet's
  opinion (relayed to the renderer in the gesture status) and falls back to the
  laptop's reading only when the tablet has said nothing.
* A `window.release` for a carry the renderer never saw a grab for no longer
  falls back to "whichever panel is selected". That fallback could yank a window
  that had already been sent back off the iPad.

### Verified

- `npm run typecheck` clean; `npm run build` clean (shared, server, receiver,
  desktop); the served receiver bundle contains `receiver.fist`, the
  `translate3d` cursor and `requestVideoFrameCallback`.
- Python: **272 passed, 0 failed**.
- The new gaze filter was run as a standalone simulation of its own arithmetic:
  one 40-degree noise spike while facing the laptop causes **no** flip; a real
  turn (35 -> 3 degrees over ~450 ms) commits after **600 ms**; a head jittering
  +/-5 degrees around the threshold for 4.5 s causes **zero** extra flips; 600 ms
  of lost face keeps the opinion, and a long loss does clear it.
- Launched the full stack twice. The log shows the service connecting with no
  errors from this pass (the only `ERROR` lines in it are from 2026-11-12), and
  the server serves the new receiver bundle to the iPad.
- Ports released cleanly after the kill.

### Not verified

Nothing here has been tried with a hand on the actual iPad. Whether 600 ms of
face-loss grace is the right balance between "the cursor came back at once" and
"it flickered" needs the device. And the transfer now has two possible witnesses
(the laptop's camera and the tablet's); I have confirmed they cannot both send,
but I have not confirmed that on a real grab the preview card appears *before*
the user opens their hand. If the transfer still misses, the line to look at is
`iPad reports the hand open` in the log, which records whether a carry was held
at that moment.

---

## 2026-11-12 (thirty-third pass) — freezes that left no evidence, and taskbar clicks that never landed

### "Sometimes it just freezes and there is no logging"

Two separate problems hid behind that report: the app could stall, and when it
did there was nothing on disk to look at.

**No evidence.** Every diagnostic went to `console`, which means the terminal
`start.cmd` opened. Close that window, launch from a shortcut, or freeze an hour
into a session, and the only record was gone. There is now a persistent log:
`packages/desktop/src/main/log.ts` writes to

```
%APPDATA%\@orbit\desktop\orbit\logs\orbit.log
```

rotating at 4 MB with two backups, mirrors to the terminal, and is written with
`appendFileSync` rather than a stream on purpose — a stream buffers, and the
process about to freeze is the one that never flushes. The Gestures page grew an
**Open logs** button.

Three things now report into it that never did:

- a **freeze watchdog**: a 500 ms timer that logs how late it actually fired, so
  a stall the event loop survives becomes a timestamped line with its duration;
- a **one-line-a-minute heartbeat** with uptime, RSS and loop lag. A stall that
  never returns writes nothing at all, so the heartbeat is what bounds the time of
  death: the last one says the process was alive then, and the silence is the
  evidence;
- **crash and child-death logging**: `uncaughtException`, `unhandledRejection`,
  `child-process-gone`, renderer `render-process-gone` / `unresponsive` /
  `did-fail-load`. A dead renderer used to leave a window that looked alive and
  ignored every click; it is now logged and reloaded (at most twice) so the app
  recovers instead of requiring a restart.

The second-instance path also explains itself now. Losing the single-instance
lock is why a relaunch used to die with "the desktop app exited with code 1" and
no message anywhere.

**The actual stalls.** Looking for what could block the main thread turned up
three real ones, none of which logged anything at the time:

1. `spawnSync` in `killStaleService` and `findPython`. Cleaning up an orphan runs
   a PowerShell CIM query (up to 8 s) and probing interpreters runs up to four
   10-second processes — all synchronously, on the thread that also serves the
   pointer stream, the window drag and every IPC call. Pressing Retry camera (or a
   busy-port retry) therefore froze the whole UI, and a blocked thread cannot log.
   Both are now asynchronous (`runProcess`), the probe is shared through one
   in-flight promise, and `start`/`restart`/`launch` became async to match.
2. **An undrained child pipe.** The Python service's stdout was piped and never
   read. MediaPipe and its native libraries do print there, and once ~64 KB had
   accumulated the service blocked forever inside `write`: no frames, frozen
   cursor, frozen preview, and no error anywhere, because a blocked pipe is not an
   error. stdout is drained and logged now, and every stderr line is persisted
   (`gestures-py` scope) instead of only the ones matching an error pattern.
3. **Unbounded writes to the pointer helper.** A helper stuck in a user32 call
   cannot read its pipe, so Node buffered every cursor frame in memory. Movement
   is disposable: past 32 KB of backlog it is dropped and logged (throttled), while
   button transitions are never dropped.

Everything between the service and the renderer is also guarded per message now:
one malformed frame used to throw out of the WebSocket handler and take the whole
frame with it.

One cause of "it just vanished" turned out not to be a freeze at all. The
launcher reports `The desktop app exited with code 3221225786`, which is
`0xC000013A`, `STATUS_CONTROL_C_EXIT`: the console ORBIT was started from was
closed, or received Ctrl+C, and Electron died with it. Closing the black window
`start.cmd` leaves behind stops the app. That is now named in the launcher's
message instead of leaving the user with a hex number and the instruction to
scroll up for an error that is not there.

### Taskbar icons lit up but the app never opened

The press itself was fine. The problem was what happened between the press and
the release: a pinch held to click also keeps emitting pointer frames, and those
frames moved the cursor. A taskbar icon is around 40 px wide, so a few pixels of
landmark jitter slid the cursor off the icon, or far enough for Explorer to read
the press as the start of a drag. The icon highlighted, and nothing launched.

The OS cursor is now frozen at the press point until the movement is deliberate:

- **12 px** of travel to start a drag, measured from where the press happened;
- **48 px** during the first **150 ms**, because closing a pinch shifts the palm
  and the smoother catches up over a couple of frames. Normal clicks are
  unaffected, real drags start a few frames later, and a pinch on an icon stays a
  pinch on that icon.

The legacy one-shot click path also stopped sending `D` and `U` back to back. The
helper's `C` command holds the button for 40 ms after a 25 ms hover pause; a
zero-length press reaches the XAML taskbar in the same message-pump turn as the
release, and it is discarded as a stray event.

### Verified

- `npm run typecheck` clean; `npm run build:main -w @orbit/desktop` clean.
- `python services/gestures/tests/test_gesture.py` — **272 passed, 0 failed**.
- Launched the real stack. The log exists and contains, in order: the startup
  header (version, Electron, pid), `State: stopped -> starting`,
  `Gesture service process started`, the service's own
  `listening on ws://127.0.0.1:8790` and `camera open, models in ...`,
  `Connected to the gesture service`, `State: starting -> running`.
- Service status read from the running app: `phase: armed`, `armed: true`,
  **26.7 fps**, `cameraMean 108.3`. First heartbeat one minute in:
  `loop_lag_ms 14`, `rss_mb 105` — a healthy loop, not a marginal one.
- One relaunch right after a hard kill still lost the single-instance race and
  exited with code 1; the next attempt started normally and the log recorded it.
  That failure mode is unchanged in behaviour, but it is no longer silent.
- The generated PowerShell helper was run on its own: `READY`, answered `T` with
  `TEXTFIELD False`, exited 0 on `Q`. So the new `C` command is in the script the
  app actually writes and the block compiles.

### Not verified

Nothing in this pass was tested with a real hand: the taskbar deadzone, the
click-vs-drag boundary, fist grab, scroll rate and left-hand desktop switching all
still need the hardware pass. The deadzone numbers are reasoned from the icon size
and the observed jitter, not measured on this machine's camera. If a click now
feels like it is sticking, 12 px is the number to lower.

---

## 2026-11-11 (thirty-second pass) — cursor gain, a window that was never a window

### The iPad cursor only covered half the screen, and was glitchy

Reported: "the cursor on the iPad has only a range of the right half of the
screen. Pretty glitchy."

Worked out the actual numbers rather than guessing. The mapping was

    x = 0.5 + (palm.x - centre.x) * 2.5

so pinning the cursor to an edge needed a hand travel of only `0.5 / 2.5 = 0.2`
in normalised camera space - about a fifth of the frame. A comfortable hand sweep
is nearer 0.35. The cursor therefore saturated almost immediately: small
movements slammed it to an edge, and it spent its life against whichever edge the
hand drifted toward, which reads exactly as "it only covers half the screen".

Three changes:

- `GAIN_X` 2.5 -> **1.4** and `GAIN_Y` 2.7 -> **1.5**, so a full sweep needs ~0.36
  of travel and the edges are reachable deliberately.
- `SMOOTHING` 0.45 -> **0.55** (lighter). Heavy smoothing layered on an
  over-amplified signal is what made it feel twitchy and laggy at once.
- `MAX_JUMP` 0.55 -> **0.85**. At 0.55 a genuinely fast movement was discarded
  outright, so the cursor froze mid-sweep.

Added a dead zone of 0.012 around the learned centre, since landmark noise alone
kept a still hand in constant sub-pixel motion.

The neutral-point calibration also had to be fixed: it took whichever eight frames
arrived first, including ones caught mid-swing. A centre learned off to one side
shifts the entire usable range with it. It now requires the samples to be
clustered within 0.08 and otherwise discards the older half and keeps sampling.

### The dropped window was a small black rectangle titled 'status'

The title was the giveaway. That was a hidden helper window being offered as a
capturable source. Sources were enumerated with `thumbnailSize: {0,0}`, which
makes a real window and an invisible 0x0 shell window indistinguishable - both
enumerate with a name, and the invisible one then captures as pure black.

The thumbnail is now always requested, even when the caller does not want it, and
a source with no thumbnail is filtered out. That window would never have been
offered.

Two further fixes in the same area:

- The grab picked `activeSourceId`, which is the window last chosen on the Setup
  page and has nothing to do with what is in front of the user now. Closing a hand
  over one window could pick up a different one. It now takes the first source,
  which `desktopCapturer` returns in Z-order, frontmost first.
- The panel's status overlay now stays until frames actually flow, and the video
  element is transparent until then. Previously a negotiated track with no decoded
  frames showed as the black rectangle with no explanation; the panel now says
  "Negotiating stream..." instead.

### Verified

- Gain arithmetic checked numerically: 0.200 of travel to pin an edge before,
  0.357 after.
- Desktop typecheck and build clean; receiver rebuilt into `packages/receiver/dist`
  which the server serves.
- Python: **272 passed, 0 failed**.
- App launches and listens on 8790 with a clean log.
- Foreground-window title readable via Win32 on this machine, confirming the
  enumeration path works here.

Not verified: the new cursor feel needs the actual iPad, and I have not confirmed
that a re-grab now produces a visible window - the source filter is reasoned from
the thumbnail being empty, not observed against the specific 'status' window.

---

---

## 2026-11-11 (thirty-first pass) — carrying a window by looking at it, and a cursor that never came back

### The handoff required shoving the window off-screen

Reported: "I should look over at the laptop, cup my fist in front to select the
window, and when i look over at my iPad with something in my hand, it should show
a preview of the window I have and if I look away it should disappear. But if i
look at my iPad and release my fist, the window transfer should take place."

The implementation did something else entirely. Transfer happened only through
`window.handoff`, which the main process emitted **only when the window had been
physically dragged past the laptop screen edge**. Releasing while looking at the
iPad deliberately did nothing - an earlier pass had removed the transfer on
release because looking at the tablet used to whisk a window away mid-drag.

Both behaviours were defensible in isolation and wrong together: the gesture had
no way to express "carry this over" except by flinging the window at a border.

Now a release while looking at the iPad *is* the send. It is safe to make it so
because the preview shows first: the user has already seen the window they are
about to send, so the release is a confirmation rather than an accident. The
release path is gated on `receiverConnected()`, so on a laptop-only session
opening the hand is still a plain drop.

### The handoff silently did nothing

Even once emitted it could not work. `window.release` clears `heldPanel.current`
before the handoff arrives in the same tick, so the handoff had no window to move.
The released id is now remembered in `lastReleasedPanel` and consumed by the
handoff.

### The preview

Added `preview?: { title }` to `WorkspaceState`, which already travels desktop ->
server -> receiver. The desktop sets it only while a grab is held **and** gaze is
on the tablet, and clears it on every other frame - so looking away dismisses it
with no timer and no chance of a stale card implying a transfer is still pending.

### The cursor never came back

Reported: "when I look over at my iPad to control the blue cursor and look back,
the laptop also uses the dummy blue cursor on the app. The real mouse pointer is
not controlled any more. I have to manually toggle it back on."

`lastPointer.gaze` was written on every pointer frame and never reset. Once the
head turned to the iPad it held `'tablet'` indefinitely. On looking back, the iPad
lost the user's face and reported `looking: null`, which makes `tabletGazeFresh()`
false - so routing fell through to `lastPointer.gaze`, which still said `'tablet'`.
The OS cursor stayed frozen and the app kept drawing its own overlay, with no way
out except toggling the system pointer off and on.

Two changes. A gaze report of `null` now means "not looking at this device" and
updates the remembered value, rather than being ignored. And pointer frames prefer
the freshly measured `frame.gaze` over the remembered one, since the live reading
is better evidence than a value from an earlier frame.

### Verified

- Receiver build clean and rebuilt into `packages/receiver/dist`, which the server
  serves.
- Desktop typecheck and build clean; app launches with a clean log.
- Python: **272 passed, 0 failed**.
- Traced the preview field through desktop `client.ts` -> `hub.ts` -> receiver to
  confirm the whole object is relayed rather than a reconstructed subset.

Not verified: the preview card's placement on a real iPad, and whether the carried
title stays readable for long window names. Not verified that releasing sends on
the first try with a real hand - the gaze reading on release is the component I
would watch next if it does not.

---

---

## 2026-11-11 (thirtieth pass) — the tracking button no longer exists

### "Why is there still a separate enable hand tracking button"

Reported twice, with the second report naming the exact location: "in the homepage
with the time and everything on the right hand side there is again a button on the
UI".

There was only ever one button, but it followed the user around. The chip is
`position: fixed; right: 14px; top: 64px`, so it floats over *every* screen — the
pairing view and the standby screen with the clock — not just the workspace. On
first entry it showed because the tracker was `off`; on the standby screen it
showed again because the automatic start had been refused by Safari and the state
had fallen back to `off` or `failed`.

So the auto-start was running and being rejected, and the button was the visible
symptom of that rejection.

### The button is gone, not hidden

The chip is now purely informational. It reports what the tracker is doing and, if
Safari refused the camera, says to tap anywhere — but there is no control to aim
at. Starting is handled entirely by the global capture-phase listener, which makes
the tap the user was already going to make the permission gesture.

The unused `.tracking-action` CSS was removed rather than left to rot, and `App.tsx`
now contains no `<button>` element at all.

### A failed start is now recoverable

The first version of the auto-start detached its touch listener after a single tap.
That made a refused attempt unrecoverable: if Safari said no, or the camera was
busy, the chip invited the user to "tap anywhere to try again" while nothing was
listening any more — the worst kind of dead end, because it looks like it should
work.

The listener now stays armed through failures and detaches only once tracking is
actually `running`, via a ref resolved at the point the state flips. A tap during an
in-flight start is ignored rather than queued.

### Verified

- Only one button existed; located by reading the fixed positioning rather than
  guessing which screen it belonged to.
- `App.tsx` contains zero `<button>` elements.
- `grep` for `tracking-action` in the receiver source returns nothing.
- Receiver `npm run build` clean, desktop typecheck and build clean.
- The server serves `packages/receiver/dist`, which was rebuilt, so the iPad gets
  the new bundle on reload.

Not verified: whether Safari grants permission on the auto-start for a returning
user, or only on the tap. That depends on iOS's per-site camera policy and needs
the device.

---

---

## 2026-11-11 (twenty-ninth pass) — grab blocked by a stale gaze latch, and the iPad ran at half rate

### Grabbing on the laptop did nothing

Reported: "When I look at the laptop and try to grab a window, nothing happens, i
cant drag the window around."

The machine was verified to emit `window.grab` correctly (a held fist in front
produces `grab.hold` then `window.grab`), and the geometry was verified to report
`in_front=True`. The event was being discarded in the main process:

```
grabOwner = currentOwner();
if (grabOwner === 'tablet') return;
```

`currentOwner()` derives from `lastPointer.gaze`, which latches to `'tablet'` as
soon as the head turns to the iPad and **never resets on its own**. So after any
session on the tablet, every later laptop grab was dropped before it could start.

This is the third time this exact latch has caused a report - it also silently
disabled desktop switching. A grab is emitted by the machine only when the right
hand is physically held in front, so it is never a tablet action by definition.
Routing is decided on release, where a fresh gaze reading exists, not inherited
from a stale pointer frame. The check is gone.

### The iPad ran the model about six times per camera frame

Reported: "in the iPad, the hand tracking isn't as good and sensitive and the FPS
is very low as well it doesn't respond correctly to my hand movements."

The tracking loop called the hand model on every `requestAnimationFrame`, which
fires ~60 times a second on an iPad, while the camera only produces ~24. Roughly
six of every ten inferences ran on the **same decoded frame** - no new
information, but a full GPU inference each time, synchronously on the main thread.
That thread also has to draw the cursor, which is why the pointer trailed the hand
regardless of detection quality.

Now driven by `requestVideoFrameCallback`, which fires once per decoded camera
frame - exactly the cadence MediaPipe's VIDEO mode expects. A `currentTime` guard
inside `detect()` makes it impossible to infer twice on one frame even via the
fallback display loop.

### Hand tracking starts by itself

Reported: "The handtracking should automatically start on iPad when I connect it.
No button needed."

Safari refuses `getUserMedia` outside a user gesture, so a page-load start cannot
work in principle. Two things now happen instead: tracking is attempted
automatically about 400 ms after mount (which succeeds when camera permission is
already granted for the session), and a one-shot capture-phase listener starts it
on the **first touch anywhere on the screen** if that is refused. The user no
longer has to find and aim at a small button on the screen they are about to
control by hand.

### Gaze routing

Reported: "When I look at the laptop the mouse pointer should move but when I
look at the iPad, the iPad's mousepointer should move."

Traced the whole path rather than changing it: iPad `reportGaze` →
`receiver.gaze` → server `hub.ts` → `server.gaze.tablet` → desktop
`client.on('tabletGaze')` → `tabletGaze` freshness → pointer frame routing. It is
wired end to end and the logic is correct (laptop gaze moves the OS cursor, iPad
gaze freezes it and lets the receiver draw its own).

The most likely reason it looked broken is that the grab was dead and the iPad
tracker was running at a sixth of its needed rate, both fixed above. No change
made to the routing itself.

### Verified

- Machine emits `grab.hold` then `window.grab` for a held fist; geometry reports
  `in_front=True` - so the loss was definitely in the IPC gate.
- Gaze pipeline traced from the iPad through the server to the desktop.
- Python: **272 passed, 0 failed**. Typecheck and build clean.

Not verified: iPad frame rate and tracking latency need the actual device. I have
not measured whether the new callback cadence improves it in practice - that
requires you to try it.

---

---

## 2026-11-11 (twenty-eighth pass) — the taskbar is a XAML surface, and a freed window handle

### Minimise crashed the app

Reproduced the mechanism by reading rather than guessing at logs.

`Grab()` captures the target window handle once and stores it in a static
`Target`; every frame of the drag then calls `SetWindowPos(Target, ...)` with no
liveness check. Minimising or closing that window frees its handle, and
`SetWindowPos` against a freed handle is undefined behaviour inside the shell —
it takes the **helper process** down, which then kills the pipe the main process
is writing to.

`MoveTarget` now calls `IsWindow(Target)` first and simply ends the grab when the
window is gone. Verified by grabbing a real window and driving 40 moves through
the helper: it survives and stderr stays empty.

### The taskbar click was being discarded by XAML, not sent wrong

"Still when i try to click something on taskbar, it only worked once with google
chrome. Other times it doesn't work."

Checked the assumption that our coordinates were wrong. They are not: the helper
moves to (700, 840) and the real cursor is measured at exactly (700, 840)
afterwards. The click lands on the taskbar.

The taskbar was enumerated to find out what we are clicking:

```
Shell_TrayWnd=65826
  Windows.UI.Composition.DesktopWindowContentBridge 0,816,1536,864
  Start 435,816,480,864
  ReBarWindow32 435,816,924,864
```

It is not a Win32 control. It is a **XAML surface** hosted in a composition
bridge. That input stack routes a press to whatever element it considers
*hovered*, and hover is established from the pointer move. Move and press were
sent back to back in the same batch, so the shell received the press before it had
registered the hover and dropped it — which is exactly why clicking worked only by
luck, and why the one success was Chrome.

`Down()` now pauses 25 ms after the move before pressing. Measured cost: 10 clicks
in 933 ms (~93 ms each), still responsive.

### Verified

- Helper moved to the taskbar band and the cursor was measured there, proving the
  coordinates were never the problem.
- Taskbar child windows enumerated to identify the composition bridge.
- Grab plus 40 drag moves: helper survives, no stderr.
- 10 clicks after the fix: no stderr, timing acceptable.
- Deployed helper contains both fixes; an app-level taskbar-band click leaves
  Electron running with a clean log.
- Python: **272 passed, 0 failed**. Typecheck and build clean.

Not verified with a real hand: whether the 25 ms settle is enough for every
taskbar button, and whether the `IsWindow` guard catches every way a window can
die mid-drag.

---

## 2026-11-11 (twenty-seventh pass) — relaxed fist read as a scroll, taskbar clicks lost, repin crash

### A relaxed fist scrolled the page

Reported: "It detects fist in front as a pinch or scroll sometimes."

Measured against the fixtures. A *balled* fist (index curl 0.94) was rejected
correctly, which is why this survived every earlier test. A **relaxed** fist — the
shape a hand actually holds while waiting to grab — measures about
`[0.46, 0.32, 0.40, 0.40]`, and that slipped through every gate:

* `curls[0] >= 0.50` (max_index_curl) did not fire at 0.46
* `outer >= 0.75` did not fire at 0.40
* the cup gate needs `outer >= 0.5625` and did not fire either

So it was accepted as a three-finger scroll: held still it turned the wheel,
moving it swept the page.

Two changes. The primary index gate drops from 0.50 to **0.40**, which is still
far above what a real scroll produces (measured: 0.14), and the folded-index
rejection is now unconditional instead of only applying when the outer fingers
are partly open. Verified directly against the same hand:

```
curls            : [0.46, 0.32, 0.40, 0.40]
OLD code result  : True   (read as a scroll)
NEW code result  : False
```

A genuine scroll still passes.

### Taskbar clicks did nothing

Reported: "whenever i try clicking on the taskbar to open an app it doesn't work.
I can see it clicking but it doesn't open."

`toScreenPoint` mapped the hand onto `screen.getDisplayMatching(ORBIT's bounds)` —
the display the ORBIT window happened to be on. The taskbar lives at the edge of
the *primary* display, so with ORBIT on another monitor (or restored there), a
hand at the bottom of the frame resolved to the bottom of a screen with no
taskbar. The click was real; it landed on empty desktop.

Now mapped to the primary display, using `bounds` rather than `workArea`: the work
area stops above the taskbar, so clamping to it made the taskbar unreachable even
on a single monitor.

`Click()` also held the button for **zero** milliseconds — down and up in the same
message-pump turn, which the shell treats as a stray event and does not commit.
It now holds for 40 ms, below the threshold of noticing and above what the taskbar
needs. Measured: 10 clicks in 540 ms, 60 moves plus a click in 109 ms, so the hold
does not stall the helper.

### Crashes

Found a concrete multiplicative bug. Every `desktop.switch` started its own
6-timer `scheduleRepin` chain, and each tick asked the helper for a COM
`VirtualDesktopManager` to answer which desktop is current. A sweep switching
several desktops in a row ran dozens of overlapping chains, each creating COM
objects against a desktop the shell was still animating. Only one chain now exists
at a time; starting a new one cancels the previous.

This is in addition to the crash containment from the previous pass, which is what
turns any remaining throw into a logged dropped frame instead of a freeze.

### Verified

- Old vs new geometry compared on the same hand: `True` then `False`.
- A real scroll still scrolls; a balled fist still does not.
- Helper: READY, clicks, field probe, and timing all measured alive.
- Python: **272 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- App launches with no errors.

Not verified with a real hand: whether the 0.40 gate now rejects any legitimate
scroll you perform, and whether taskbar clicking works from your actual cursor
positions.

Note on the test I added for the fist: my first three attempts at a fixture passed
with the fix reverted, because the fixtures were not reproducing the real hand.
The discriminating values are index 0.46 and outer 0.40 — a genuinely relaxed
fist — and only then does the test fail on the old code.

---


## 2026-11-11 (twenty-sixth pass) — desktop switching, WisprFlow-style dictation, reliable grab

### Desktop switching was silently discarded

Reported: "The desktop switching is not working."

The machine was emitting `desktop.switch` correctly (verified: 6 events across a
sweep), and the helper switched desktops correctly when called directly
(verified by reading the current desktop GUID before and after: changed on right,
restored on left). The break was in between.

`desktop.switch` carries no `gaze` field, so `resolveGaze` fell through to
`lastPointer.gaze` — the *right* hand's routing decision. Once the right hand had
been pointed at the iPad that value stuck, and the handler returned early on
`gaze === 'tablet'` for every subsequent left-fist sweep.

The left hand's gesture must not depend on where the right hand last went, and
virtual desktops have no iPad counterpart to route to in the first place. The
gaze check is gone; only the master `systemPointer` switch still applies.

### Dictation now behaves like WisprFlow

Reported: "I need dictation to work properly as well. Similar to wisprflow. I
should be able to dictate and it will paste that text into the selected text
field or if no text field is selected, there should be a copy option."

It was a bare Win+H toggle with nothing behind it. Now:

* On `dictation.start` the helper is asked whether a text field has focus, via UI
  Automation (`HasFocusedTextField`, new `T` command). That is decided **before**
  speaking begins, because gesturing can move focus.
* With a field focused, Windows voice typing inserts into it directly.
* With no field, the cup ending emits `dictation.copied` so the renderer can
  offer the text, instead of worrying it was typed into a random window.
* Failing to answer defaults to `false` — the clipboard — never "paste somewhere
  unexpected".

The helper now compiles with `-ReferencedAssemblies 'UIAutomationClient',
'UIAutomationTypes', 'WindowsBase'`. Without that, `Add-Type` does not find
`System.Windows.Automation` and the *whole helper* fails to reach READY, taking
every pointer command with it.

### The grab was dropped mid-drag

Reported: "Grabbing a window and moving it around doesn't function reliably
either."

A fist in front and a cupped fist at the mouth overlap in projection, so single
frames of a moving drag land inside the mouth band. `_update_dictation` cleared
`_front_since`, which ended the grab: the window stopped following the hand and
the next frame had to start a fresh hold. An active grab now owns the hand until
the user actually opens it.

### Verified

- Desktop switching proven by GUID before/after: right changes it, left restores.
- Helper compiles and reaches READY with the UIAutomation reference; the field
  probe answers `TEXTFIELD False` with no field focused.
- Drag survives mouth-band flicker: no `dictation.start` during a grab, grab
  still held afterwards.
- Python: **269 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- App launches with no errors; the deployed helper contains the new `TEXTFIELD`
  command.

Not verified with a real hand: the left-fist sweep actually moving desktops end
to end, dictation pasting into a real focused field, and drag smoothness.

---


## 2026-11-11 (twenty-fifth pass) — the freeze after disable/re-enable/pinch

### Reported

"Sometimes when I disable control of mouse pointer with hand to recenter cursor
and then enable it back, and then pinch, the app just crashes. Everything just
freezes and I have to close and reopen it."

### What I found

Two missing safety nets, and one of them had to be the cause.

**The main process had no `uncaughtException` or `unhandledRejection` handler at
all.** One throw inside a gesture handler therefore took down the whole process
with no message and no recovery. Gesture events arrive ~30 times a second from a
separate Python process, so they are by far the most likely thing to throw.

**The renderer had no error boundary and no `window.onerror` either.** A throw
while handling one of those events unmounted the entire React tree — the window
stayed open but painted nothing. That is precisely "everything freezes and I have
to close and reopen it": the process is alive, the UI is dead.

The trigger being *disable → re-enable → pinch* fits this exactly. Toggling the
pointer restarts the flow the pinch depends on, and a pinch that lands in the
gap between the old state and the new one is the frame that throws.

### What changed

* `process.on('uncaughtException')` and `process.on('unhandledRejection')` in the
  main process. Gesture input is best-effort: log the frame, drop it, keep
  running. The next frame arrives 33 ms later carrying the current truth.
* `window.addEventListener('error')` and `('unhandledrejection')` in the renderer.
* The `on()` helper in `env.ts` — the single funnel every renderer event passes
  through — now wraps each listener in a try/catch. A malformed frame is dropped
  and the list keeps working.
* `stdin`/`stdout` `'error'` handlers on the pointer helper, plus a `destroyed` /
  `writableEnded` check before every write, so a pinch that lands on a helper
  being replaced cannot leave a stream error unhandled.

### Verified

- The guarded listener was replicated and tested directly: a deliberately
  poisoned frame is logged and dropped, and the following two frames paint
  normally — "RECOVERED", not "STILL FROZEN".
- The process-level nets were tested against both a synchronous throw and an
  async rejection: both are caught and the process stays alive.
- Python: **266 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- The app launches with no uncaught errors in stdout or stderr.

I could not reproduce the original freeze on demand — it needs a real pinch in
the gap after a re-arm — so the specific throwing line is still unknown. What is
now guaranteed is that whatever it is, it can no longer freeze the app: it gets
logged and the next frame is processed normally.

---


## 2026-11-11 (twenty-fourth pass) — a grabbed window stays on the laptop until you drag it off

### What was wrong

Reported: "When I said grab the window I think you didn't understand properly. If
I grab it, it should move within the laptop first. Only if I then look at the
iPad and drag the window out of bounds of the computer screen, should it hide it
from the computer and transfer it to the iPad."

The old model read the grab as a *routing* gesture. On `window.release` it looked
at which screen you were facing and moved the window there. Two consequences,
both wrong:

* Looking at the iPad while letting go of a window sent it to the iPad even when
  it had never left the laptop.
* The drag itself was unbounded, so pushing the hand right walked the window off
  the edge of the screen and it disappeared while still being dragged.

A grab is *direct manipulation of a window on the laptop*. It only becomes a
transfer at the moment the window is physically pushed off the screen.

### What it does now

* The drag is **clamped to the laptop screen**. Grab a window and move it and it
  travels freely, but stops at the border instead of sliding out of view.
* Gaze alone never moves a window. `window.release` no longer transfers anything;
  releasing simply leaves the window where it was dragged.
* `window.handoff` is a new event, emitted only when the window is at the screen
  edge **and** the user is looking at the iPad. That is the transfer, and it is
  the only path that puts a window on the tablet.
* Once handed off, the drag ends so the window does not fight the capture.

### Two bugs found while testing this

* **The handoff was unreachable.** The first version required the window to be
  15% of a screen width *past* the edge. Hand coordinates are normalised 0..1, so
  a window grabbed mid-screen can travel at most one screen width — it never gets
  15% beyond the right edge. Measured: the furthest reach was x=1735 against a
  threshold of 2208, so the transfer could never fire. Now the test is *at* the
  edge, which the clamp already makes deliberate.
* **The edge test used a stale position.** It ran before the easing update, so it
  compared last frame's coordinates against this frame's hand. Easing now happens
  first and the decision second.

### Verified

- Simulated the drag maths directly. Looking at the laptop: the window stops at
  the border (x=1920) and **never** hands off. Reaching the edge and then looking
  at the tablet: `HANDOFF` fires.
- Python: **266 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.

Not verified with a real hand and a real window — the clamp, the edge reach and
the capture handoff need a physical grab to confirm.

### The four-finger desktop slide

Asked again whether the smooth trackpad desktop slide can be replicated
universally. Checked rather than assumed this time:

| Approach | Result |
|---|---|
| `IVirtualDesktopManager` (public, already in our helper) | Has only `IsWindowOnCurrentVirtualDesktop`, `GetWindowDesktopId`, `MoveWindowToDesktop`. **No switch method.** |
| `ImmersiveShell` via `CoCreateInstance` | `hr=0x80004002` E_NOINTERFACE — refuses external callers |
| Taskbar HWND to shell object | Hard segfault in `GetObjectForIUnknown` |
| CLSID registration | Registered, but no `InProcServer32` DLL — activated internally |

So a universal, smooth, OS-level desktop slide is not available. `Win+Ctrl+Arrow`
is the only switch path that works without version-pinned vtable offsets, and it
snaps. Left as is per "if it is not possible leave it".

---


## 2026-11-11 (twenty-third pass) — everything but the pinch was dead, and the desktop slide is continuous

### Only the pinch worked

Reported: "none of the gestures except the pinch works."

A one-word regression, mine, from the pass before. `serve.py` passed
`scrolling=pointer.scrolling and self.machine.scroll_armed` into `detect_fist`,
and `detect_fist` short-circuits to `in_front=False` when `scrolling` is true.

A fist satisfies the three-finger scroll pose too — ring and pinky curl to nearly
the same values — so the moment the wheel armed, the hand was reported as
"scrolling" on every frame and the grab branch could never run again. The arm
stayed set once you had scrolled at any point, so grab and dictation stayed dead
for the rest of the session while the pinch (which runs on its own path) kept
working.

Now gated on `machine.scrolling` — the wheel's *live* state, which ends with the
wheel — instead of the armed flag. Verified: a held fist grabs, a sustained cup
at the mouth dictates, and a real vertical sweep still scrolls without grabbing.

### The desktop slide is a proportion, not a step counter

Reported: "one step should not equal to one desktop... as I move from right to
left or vice versa with my left fist, it should slowly move the thing in that
direction until it eventually reaches the next desktop similar to a trackpad 4
finger gesture. Not a sudden jerk."

Correct, and the previous code was exactly the thing being complained about: it
counted whole `desktop_step` chunks of travel and fired a switch per chunk, so
any movement past the threshold was an instant jump.

It is now a **continuous proportion**. `_desk_progress` accumulates sideways
travel as a fraction of one step in the range -1..1, and a desktop is committed
only when the hand covers a *whole* step. Measured:

* A nudge of 0.07 (well under the 0.12 step) switches **nothing**, and leaves
  progress at 0.58 — the travel is remembered but not acted on.
* Continuing to slide commits **one** desktop when progress reaches 1.0.
* A long steady sweep across the frame produces an evenly spaced series of
  switches rather than one jump.
* Reversing mid-slide discards the banked progress and restarts from the
  turn-around point, so a hand that had built 90% of a step and turned around
  cannot still commit the desktop it just left.

Windows cannot animate the slide itself — Win+Ctrl+Arrow is the only public entry
point and it snaps — so the *decision* is progressive even though the shell's
final move is instant. That is a platform limit, not a tuning choice.

### Verified

- Python: **266 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- New tests: a short nudge switches nothing but banks progress; sliding past a
  full step commits exactly one desktop; reversing cancels the progress.
- Grab and dictation re-verified directly after the regression fix.
- App launched end to end with no errors in stdout or stderr.

Not verified with a real hand: the 0.12 step size (whether a comfortable arm
sweep reaches one desktop), and whether the missing animation still feels abrupt
enough to matter.

---


## 2026-11-11 (twenty-second pass) — unsticking the wheel, actually drawing the left hand, and a trackpad-style desktop swipe

### Scrolling never stopped

Reported: "Once I start scrolling and unpinch my fingers, it gets stuck in
scrolling mode."

A self-refreshing latch, introduced by me two passes ago. `detect_pointer` was
given `was_scrolling` and returned `scrolling=True` whenever it was set — and
`serve.py` then refreshed its "last seen scrolling" timestamp from that same
returned value. The latch therefore re-armed itself on every frame and could
never expire, so opening the hand left the wheel running forever.

`was_scrolling` still suppresses the click, which was its entire purpose, but it
no longer reports the pose. The caller owns the timing. Verified: scrolling ends
1.6 s after the pose stops.

### The left hand still was not drawn

The service was sending `landmarks.hands` (added last pass), and the renderer was
reading it. The field was being dropped in between: `normaliseStatus` in
`packages/desktop/src/main/gestures.ts` rebuilds every status field by hand, and
`hands` was not in that whitelist. The renderer therefore always took its
single-hand fallback.

Added to `normaliseStatus` and to the main-process `GestureStatus` type. Verified
against the live service: `landmarks` now carries `face`, `hand` **and** `hands`,
with a real hand in it.

### The desktop swipe is now the trackpad gesture

Reported: "I shouldn't have to unclench my fist. It should move the desktops as I
move my fist just like how it would be if I would just use 4 fingers on my
trackpad."

The previous rule switched once per cup and required an unclench between
switches — not the trackpad at all. It is now continuous:

* Hold the fist and move. Every `desktop_step` of horizontal travel switches one
  desktop, in the direction of the movement, for as long as the fist keeps going.
* **No unclenching between switches.** Releasing only re-anchors, so the next
  fist is measured from where it forms instead of from where the last one ended.
* The anchor advances by exactly the travel consumed, so slow movement accumulates
  instead of being discarded each frame. Without that, slow sweeps never fired.
* Direction comes from the movement, never from alternating, so it is predictable.
* `desktop_step` 0.20 → **0.12** and `desktop_cooldown_ms` 800 → **120**, because
  the old values made one swipe cover most of the frame before anything happened
  and then paused a long time before the next. `desktop_max_steps_per_frame = 2`
  stops a fast sweep trying to cross twenty desktops in one frame.

### Verified

- Python: **260 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- New/rewritten tests: a held fist walks desktops as it moves and reverses with
  the hand, a *still* fist switches nothing, partial travel carries between
  frames, releasing re-anchors, and an unbroken sweep keeps switching without
  release.
- Scroll unstick verified directly: `scrolling` True during the pose, False after.
- The compiled main process was checked to contain the `hands` pass-through, and
  the live service was confirmed to send a populated `hands` array.

Not verified with a real hand: the 0.12 step and 120 ms cooldown cadence (whether
it switches too eagerly or too sluggishly), and whether both skeletons appear —
that needs two hands in frame on your machine.

---


## 2026-11-11 (twenty-first pass) — a centred cursor, both hands drawn, and a desktop switch that just works

Four reports, four distinct causes.

### The cursor starts offset to the right

`pointer_position` scales the palm around a neutral point, and with no
calibration that point was `POINTER_CENTER` — the middle of the **camera frame**.
Nobody holds their hand in the middle of the frame, so the cursor started offset
by exactly how far off-centre the hand rested, and it had to be re-centred by
hand every launch.

Measured with a hand resting at x=0.62: the cursor landed at **0.92**, hard
against the right edge. That is the report, numerically.

The neutral point is now learned from the first few steady sightings of the palm
(`AUTO_CENTER_SAMPLES = 8`, median so one moving frame cannot bake in an offset).
Same hand now maps to **0.50**, dead centre. Sampling stops as soon as a point is
established — if it kept following the hand, moving the cursor would move its own
origin and the cursor would drift forever. A deliberate calibration still wins,
is never overwritten by the learned value, and cancels it.

### Only one skeleton was drawn

The tracker was already following two hands (`num_hands=2`); the preview payload
sent only `landmarks.hand`, the right hand that drives the cursor. So a detected,
working left hand was invisible, which read as "not tracked at all".

`landmarks.hands` now carries every detected hand with its label, and the preview
draws all of them — the left one dimmer, behind the cursor hand. The field is
optional in the renderer type so an older service build still draws the single
hand instead of nothing.

### "Left hand only — use your right"

The left hand drives the desktop swipe perfectly well on its own, so the label
was scolding the user about a frame that was working. It now reads "Left hand —
desktop swipe; raise right to point".

### The desktop switch needed the right hand, and worked half the time

Three separate faults:

1. **A cup needed 20% of the frame of sideways travel.** A cupped hand re-formed
   in place produces almost none, so it only fired when the arm happened to
   drift. Forming the cup is the gesture; the travel was never the point. A fresh
   cup now switches immediately, and successive cups **alternate** direction, so
   cupping repeatedly walks the desktops back and forth — which is what was
   asked for: "responsive to the point where I should be able to continuously cup
   my left fist and switch back and forth".
2. **The gesture never re-armed when the hand left the frame.** The reset only ran
   when a left pointer was present, so lowering the hand — the release half of
   the gesture — left it un-armed. The reset now runs unconditionally.
3. **The cooldown was 800 ms**, which made repeated cups feel unresponsive.
   350 ms is enough that one cup cannot register twice as the fist wobbles.

A deliberate sideways sweep still moves several desktops, one per `desktop_step`,
so the old behaviour is a subset of the new one rather than gone.

### Cupped fist vs scroll, while the hand is moving

The remaining overlap is real physics: a cup and a scroll reach nearly the same
ring/pinky curl, and a fist *in motion* looks exactly like a sweep. Tightening the
`open_curl` band alone lets fists through.

`three_finger_pinch` now also rejects the combination that identifies a cup — an
only-partly-open ring/pinky *together with* a folded index — while leaving a real
reach (straighter index) alone. Measured on a moving cup: one stray notch then a
clean grab, against four notches and no grab before.

### Verified

- Python: **257 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- Two new tests: `test_repeated_cups_walk_desktops_back_and_forth` (six cups →
  six alternating switches) and `test_the_desktop_swipe_rearms_when_the_hand_leaves_the_frame`.
- Auto-centring proven numerically: 0.92 → 0.50 for a hand resting off-centre.
- Live service queried over its websocket: `landmarks` carries `face`, `hand` and
  **`hands`**, cameraMean 113, face visible, 28.4 fps.

Not verified with a real hand: whether one stray notch still appears when you cup
while moving, and how the 350 ms cooldown feels when cupping fast. Both need you
in front of the camera.

---


## 2026-11-11 (twentieth pass) — a fist is a grab, and dictation actually dictates

*"Whenever I try to grab a window, it detects it as scrolling and scrolls
instead. It even says scrolling on the stat bar instead of window grab. Also
enable dictation when I cup my fist next to my mouth."*

### The fist that stayed a wheel

Arming was decided by travel alone: 5% of the frame inside 400 ms turned the pose
into a wheel. Bringing the fist *into* position covers far more than that, so the
wheel armed on the way up — and once `_scroll_armed` was set it stayed set for as
long as the pose held. Measured with a realistic 500 ms raise: **three notches
fired and `window.grab` never fired at all.** That is exactly the report.

Arming is now revocable. An armed wheel that stops travelling for `scroll_arm_ms`
hands the pose back to the grab path and drops its accumulator. A real sweep keeps
moving; a fist settles and holds. After the fix the same 500 ms raise grabs, and
stops scrolling as soon as the hand is still.

This pass also records what was **tried and rejected**, because each looked
plausible:

- Starting the accumulator clean at arming. Killed ordinary slow sweeps — six
  tests, because at 5-10 fps the arming travel is most of a notch.
- Requiring a second frame of travel before arming. Same six failures.
- A one-frame confirmation gate on the first notch. Eight failures.
- Vetoing the wheel whenever the hand is in the grab band. Broke every scroll
  test: scrolling is done with the hand out in front too, so the band cannot
  separate them.

None of those survived the suite, so none shipped. The revocable-arming change
does, and the four new/updated tests prove it.

Some notches during the *raise* are unavoidable and are not a bug: the hand
genuinely travels up into position and the machine cannot know the intent yet.
The test asserts the property that matters — the grab fires, and nothing scrolls
once the fist is held.

### Dictation was a gesture with nothing behind it

The machine already emitted `dictation.start` correctly (verified directly: a
sustained cup at the mouth produces `dictation.start`). The desktop received it,
forwarded it to the renderer, and **the renderer ignored it** — nothing anywhere
listened. So the gesture was real and the action did not exist.

`dictation.start`/`.stop` now tap **Win+H**, Windows' own voice typing, via a new
`H` helper command. Using the engine Windows already has beats inventing a second
one: it brings its own microphone, language and privacy settings. Win+H is a
toggle, so ending the cup turns it back off rather than leaving the microphone
live after the hand comes down. Gated on `systemPointer` and skipped while the
iPad owns control, like the other system actions.

### Verified

- Python: **255 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- `test_a_fist_raised_then_held_grabs_instead_of_scrolling` was run against the
  unfixed code and fails there with `['grab.hold', 'pointer.scroll',
  'pointer.scroll']` — no `window.grab` — which is the reported symptom.
- The extended helper C# compiles under PowerShell, exposes `Dictation`, and a
  live helper process accepted `H` and exited with empty stderr.

Not verified with a real hand: whether your raise is slow enough for the
`scroll_arm_ms` revoke to land before you expect the grab, and whether Win+H
behaves with the target app focused. Both need the camera and the desktop.

---


## 2026-11-11 (nineteenth pass) — the left hand on its own, a drag that survives, and a window that stays put

Three reports in one go:

1. *"the left hand does not work unless my right hand is visible"*, and the window
   movement was *"abrupt"*.
2. *"when I change the desktop, the app is running on this desktop so it doesn't
   work anymore"*.
3. *"the scrolling is not smooth. Sometimes instead of scrolling it selects... and
   moving windows does not work at all."*

Each was a real bug, and each is now covered by a test that fails without the fix.

### The left hand depended on the right hand

`_update_desktop_switch` sat *after* the tracking gate. That gate is
`hand_visible and face_visible and ...`, and `hand_visible` is the **right** hand
— the pointer is right-hand-only by design. So with the right hand out of frame
the machine took the `not tracking_ok` path, called `_clear_holds()`, and returned
before the swipe could accumulate any travel. The anchor was reset every frame,
so a left-hand swipe only ever worked while the right hand happened to be up.

The left-hand block now runs **before** the gate. The two hands are independent
gestures; neither may gate the other.

The test drives it with `hand=False, face=False` — genuinely no right hand in
frame. Put back in the old position, the test reports no switch at all.

### Scrolling selected instead of scrolling

`detect_pointer` accepted `was_scrolling` and **never read it**. The scroll pose
is checked before the pinch, but on any frame where the third finger drifted off
the thumb the pose stopped matching and the hand fell straight through to the
pinch test — pressing the button in the middle of a scroll. That is the "it
selects" report: the wheel stuttered and a selection started underneath it.

A running scroll now keeps `scrolling=True` and suppresses `pinch`. The latch is
bounded by `SCROLL_STICKY_MS = 250` in `serve.py`, matching the wheel's own grace
window, so a dropped frame cannot click mid-scroll but opening the hand still
ends the scroll immediately.

### Moving a window stopped as soon as the pose read as a scroll

The pointer handler did `if (frame.scrolling) return;` **before** the drag. A fist
and the scroll pose are the same shape on a real hand, so a few drift frames
flipped the classification and the desktop dropped every drag frame while it
"scrolled the page" instead. Once a window is physically held, the drag owns the
frame: the guard is now `if (frame.scrolling && !windowDrag) return;`.

### The abrupt movement

Window positions were sent raw every frame and rounded to whole pixels, so at
30 Hz with landmark jitter the window juddered and could jump several pixels on
one bad frame. `windowDrag` now keeps `smoothX`/`smoothY` and steps 35% of the
way to the target each frame (`WINDOW_DRAG_EASING = 0.35`). That smears the
jitter into motion the eye reads as smooth at the cost of one frame of latency.

### Switching desktop stranded ORBIT

The Win+Ctrl+Arrow that the swipe sends moves the **entire** desktop, ORBIT
included. So after one switch the app was on the desktop the user had just left
and looked dead.

Electron cannot help here — `setVisibleOnAllWorkspaces` is documented as
"does nothing on Windows". The helper now pins instead: `IVirtualDesktopManager`
(`IsWindowOnCurrentVirtualDesktop` / `GetWindowDesktopId` /
`MoveWindowToDesktop`) behind a new `Z <hwnd>` command, re-sent six times over
720 ms after each switch because the shell animates it and the new desktop is not
current the instant `switchDesktop` returns.

### Verified

- Python: **251 passed, 0 failed**. `npm run typecheck` and `npm run build` clean.
- The three new tests were each run against the *unfixed* code and fail there:
  left-hand switch `[]`, scroll-click `scrolling=False`.
- The helper C# compiles under PowerShell, and `PinToCurrentDesktop` returned
  `True` on a live foreground window and on the shell window, and correctly
  refused `IntPtr.Zero`, run directly against the extracted helper source.

Not verified with a real hand: whether `WINDOW_DRAG_EASING = 0.35` feels right,
and whether the pin genuinely keeps ORBIT on screen through a real desktop
switch (that needs a live switch with the app running).

---

## 2026-11-11 (eighteenth pass) — a gentler wheel, and a fist that can still grab

Reported: *"Decrease the scrolling sensitivity, when I try to grab a window by
putting my fist in front, it detects it as a scroll motion not a grab window
motion. Also if I grab in front with my left hand, make it scroll between
desktops."*

The left-hand desktop switch was already built in the seventeenth pass and is
wired end to end (`desktop.switch` → `systemPointer.switchDesktop` → the helper's
`K +/-1` → Win+Ctrl+Left/Right). It needed no change; the hand just has to be
read as a left fist held in front.

### Sensitivity: one notch now costs more travel

`scroll_step` 0.06 → **0.10** screen heights per notch. A 0.08 sweep that used to
produce a notch now produces none; 0.12 gives exactly one. This is the requested
"decrease the sensitivity".

That change exposed a second bug in the same path. `scroll_max_speed` was 3.5
screen heights per second, a guard against landmark jumps. Making the wheel less
sensitive means reaching a notch takes *more* travel, so an ordinary deliberate
sweep crosses the guard and gets discarded as a glitch — scrolling went dead
outright. Raised to **6.0**, which still rejects a real landmark jump (a 40% jump
in one 33 ms frame is ~12/s).

### The fist that turned into a wheel

The pose gates already separated fist from scroll (`max_index_curl` 0.50, against
live readings of 0.12 for a scroll and 0.57-0.74 for a fist), so the remaining
hole was the *arming* rule. A closed hand only becomes a wheel after travelling
`scroll_arm_distance` inside `scroll_arm_ms`. Reaching forward and closing the
hand produces a little travel on its own; when that crossed the arming distance
the wheel started and the grab branch was skipped for the rest of the gesture.

Arming now requires the travel to be *held*: if the hand comes back under the
arming distance the motion is forgotten, and the pose only re-bases after
`scroll_arm_ms` of staying still. A fist that settles into position therefore
stays a fist and grabs.

### Verified

- Python: **244 passed, 0 failed**.
- New `test_a_fist_that_drifts_while_forming_still_grabs` reproduces the report
  and fails if `scroll_arm_distance` is loosened back to 0.02 — checked by
  running it with the old value, where the wheel arms on the drift.
- Direction tests (`up` pushes content up, `down` pushes it down) still pass.

Not verified with a real hand: whether 0.10 per notch feels right, and whether
the left fist lands in the `in_front` band where the arm naturally goes. Both
need the camera.

---

## 2026-11-11 (seventeenth pass) — a fist is not a wheel, and the left hand drives desktops

Live report after the wheel was actually fixed: *"When I try to grab the window,
it is scrolling smoothly (very smoothly) but inverted. When I actually try to
scroll, it doesn't scroll properly at all. It is at like 1 FPS."* Then: *"Decrease
the scrolling sensitivity… when I try to grab a window by putting my fist in
front, it detects it as a scroll motion not a grab window motion. Also if I grab
in front with my left hand, make it scroll between desktops."*

### The scroll rate: the guard threw away real sweeps

The wheel was fine; the frames were not. The jump guard compared one frame's
travel against a fixed 10 % of the screen height. At the 5–10 fps this laptop
drops to under load, one frame of an ordinary sweep moves more than that, so
almost every frame was discarded — the "1 FPS" report was literal. It now tests
**speed** (3.5 screen heights per second) and keeps any travel the 3-notch
per-frame cap holds back instead of dropping it, so a fast sweep lands in one go.

Direction was also backwards: the page now follows the hand. Hand up sends a
negative wheel delta, so the content moves up with it.

Sensitivity is reduced from 0.035 to **0.06 screen heights per notch** — real use
showed a held hand drifting into wheel notches.

### The real bug: a fist and a scroll pose are the same shape

The live probe (status stream, 3D reach metrics) settled it. Fist frames and
scroll-pose frames, recorded minutes apart on the same hand:

```
fist    ispan 0.45-0.58  mspan 0.47-0.66  index curl 0.57-0.74  ring 0.52-0.66  pinky 0.25-0.53
scroll  ispan 0.96-1.10  mspan 1.21-1.38  index curl 0.00-0.12  ring/pinky open
```

The **outer fingers do not separate the poses** — the fist's ring/pinky curls
(0.52–0.66) sit inside the open-finger gate, and an earlier fist attempt reported
0.6–0.8 on the ring/pinky just like a scroll frame. That is why every gate that
accepted the scroll accepted the fist. The **index does** separate them by a mile:
a scroll *reaches* with the index (tip-to-knuckle span ~1.0 hand-widths, curl
~0.1), while a fist folds it (span ~0.5, curl ~0.7).

`three_finger_pinch` now requires `index curl < 0.50`, and the test fixture was
rebuilt to model a reaching hand instead of folding the index back into the palm
(the old fixture scored 0.89 and had been validating the bug).

Movement is a second backstop: the wheel stays off until the closed hand has
travelled **0.05 screen heights within 400 ms**, and a pose held still re-bases
instead of drifting into a scroll. At 0.06 per notch that travel is less than a
notch, so arming costs nothing. Once armed, the wheel keeps the pose until the
hand opens, so slowing mid-scroll does not turn the drag into a grab.

`detect_fist` is now told only about an *armed* wheel, not the raw pose, so a
held fist is measured for the front band and can grab.

### Left-hand fist: virtual desktop switching

MediaPipe already runs two hands. The left hem is read separately (own
`detect_fist` call), and a left fist in front becomes a horizontal switcher:
0.20 screen widths of travel fires `desktop.switch`, once per sweep with an
800 ms cooldown. The desktop helper sends Win+Ctrl+Left/Right, which is exactly
what the four-finger trackpad swipe triggers on Windows; there is no public API
for the gesture itself. The left hand still never touches the cursor.

### Verified

- Python: **241 passed, 0 failed**.
- `npm run typecheck` clean; desktop main rebuilt.
- The new C# `Desktop()` compiles in the shipped helper source, and a real
  `Desktop(1)` → `Desktop(-1)` round trip was sent successfully.
- ORBIT relaunched: `phase: armed`, `cameraMean 135.7`, 17.4 fps.

Not yet verified with a real hand: whether the front band sits where the left arm
naturally goes, and whether one sweep feels like the right amount of desktop
travel. The index-curl margin is wide (0.12 versus 0.57 on the recorded frames),
so the grab should now win without a dwell.

---

## 2026-11-11 (sixteenth pass) — the wheel helper had never turned the wheel

Live report: zooming the hand into the scroll pose froze the cursor in place but
the page did not move, and dragging a window worked once, then jumped and
refused to behave. Two unrelated defects, both reproducible without guessing.

### Bug 1: `[OrbitMouse]::Wheel()` threw on every call, and a `catch { }` hid it

The pointer helper is a C# class compiled from a PowerShell here-string. It had
both

```csharp
public const uint WHEEL = 0x0800;
public static void Wheel(int notches) { ... }
```

PowerShell resolves members **case-insensitively**, so `::Wheel` matched the
`WHEEL` constant first and the call failed with "does not contain a method named
'Wheel'". That call sat inside `catch { }`, so the helper carried on, answered
every other command, and silently ignored every `S` (scroll) command. The gesture
machine *did* recognise the pose — which is why the cursor froze — but no wheel
message ever left the process.

Renamed the constant to `MOUSEEVENTF_WHEEL`, Windows' own spelling, so the
method name is unambiguous.

Proof, using the exact helper the app ships, against a real Chrome page and read
back through UI Automation's scroll percentage:

```
start 0%   S -3 -> 3%   S -3 -> 6%   S 3 -> 3%
```

Three notches per command, both directions. Also verified `WM_MOUSEWHEEL`
reaches a window via `SendMessageTimeout` (`sendOk=1`), and that the wheel now
goes to the window **under the cursor** rather than the focused window (which is
ORBIT itself while the user watches the Gestures page).

### Bug 2: a misread pinch silently cancelled a held grab

A balled fist rests its thumb beside the index, so single frames are recognised
as a thumb-index pinch. The pinch branch called `_clear_holds()`, which nulled
`_grab_phase` **without emitting `window.release`**. The desktop therefore kept
dragging a window the service had already forgotten; when the fist was read
cleanly again the hold completed *again* and `window.grab` re-based the window at
the rectangle fetched from `GetForegroundWindow` — the jump, and the reason a
second drag looked like a restart of the first.

Now a held grab owns the hand: while `_grab_phase` is set, pinch and scroll are
suppressed before the pointer path, so a misread pinch cannot click, scroll or
release it. The existing 300 ms release grace still covers `in_front` dropouts,
and only a real release or `gesture.reset` ends the drag.

Two smaller corrections in the same area:

- `pointer.scroll` now carries its gaze target like a click, so looking at the
  iPad does not turn the laptop's page.
- The cooldown after releasing a grabbed window is 400 ms, not 1.5 s. The 450 ms
  fist hold already prevents accidental re-grabs; making the user wait two
  seconds to pick up a second window was just friction.

### Verified

- `python services/gestures/tests/test_gesture.py` — **212 passed, 0 failed**.
  New coverage: a misread pinch cannot cancel a held grab, a misread three-finger
  scroll cannot turn the wheel mid-drag, and a fresh fist grabs a second window
  after a release.
- Typecheck and full build clean.
- Shipped helper, real Chrome page: three notches per `S` command in both
  directions (numbers above).
- ORBIT relaunched: `phase: armed`, `cameraMean: 133.5`, `cameraDark: false`,
  hand detected, 16–30 fps.

**Still not verified:** the feel of a real scroll sweep (how many notches a
comfortable hand movement produces) and a full drag with a live fist. Both need
the user in front of the camera; the mechanics are now proven, the tuning is not.

---


The tenth-minute live sample settled the "my fist is not recognised" question in
an unexpected way: **18,518 frames at ~30 fps, zero hands and zero faces**. No
amount of curl tuning can help if MediaPipe is handed nothing to measure.

Diagnosis, in order:

1. The gesture service was healthy: `phase: armed`, no camera error, 30 fps.
2. Opening the same camera from a second process *while the service held it*
   returned `ok=True` with **mean brightness 0.0** — a black stream, not a busy
   error. Windows will do that: the device is handed over, but no frames arrive.
3. With the service stopped, the same camera produced a normal frame (mean 107).
   The frame showed an empty room with a drying rack. Nobody was in front of the
   webcam during the sample.

So the real-hand reports could not be reproduced from this shell; the gesture
code was never given a hand. The honest conclusion is that the fist threshold
remains unvalidated on a real hand, and the sampler is what will validate it.

### Fix: measure the frame, not just the landmarks

A black stream is indistinguishable from an empty room in the old status: both
produce `handDetected=False, reason: no hand`. `Tracker.read()` now reports
`frame_mean`, the service exposes `cameraMean` / `cameraDark`, and the Gestures
page shows the brightness plus a warning banner. If the stream stays below 6/255
for two seconds, `Tracker.reopen_camera()` releases and reopens the device
(rate-limited to once per eight seconds, skipped for the first 90 frames so a
camera's normal start-up fade cannot trigger it). This is exactly the failure
mode found in step 2: a second open reads black for as long as it lives, and a
reopen once the other app lets go recovers it.

The preview draws landmarks, never video, so a black camera used to look like a
merely idle page. It no longer can.

### Fix: one hidden finger no longer loses the fist

The grab rule required middle, ring *and* pinky above the curl gate. In a fully
balled fist the pinky frequently hides behind the palm and reads partly open,
which rejected the whole pose. The rule now still passes when all three are
closed, or when the two strongest are at least 0.80. That keeps a natural pinch
out: it closes the middle but leaves the ring and pinky open, so its second
strongest finger stays well below 0.80. A regression test covers both the
weak-pinky fist and the single-curled-finger non-fist.

### Verified

- `python services/gestures/tests/test_gesture.py` — **190 passed, 0 failed**.
- Typecheck and build clean.
- Live tracker probe (service stopped): `success=True`, brightness ~106,
  640×480, `reopen_camera()` returns True and frames keep flowing.
- Live service after relaunch: `phase: armed`, `cameraMean: 109.5`,
  `cameraDark: false`, 31 fps.
- The `cameraMean` field appears on the wire and is normalised by the desktop
  main process.

**Still not verified:** fist/scroll/window-drag with a real hand in frame. The
camera is working; the user has to be in front of it. The Gestures page now says
whether it is an empty room or a dead stream.

---

## 2026-11-11 (fourteenth pass) — a real fist, a real window, and a three-finger scroll

Reported as: "When I ball my fist fully it doesn't work. And it also doesn't grab
the active window and allow me to move it around. Also, when I pinch with my
index, middle and thumb, I want it to scroll."

### Fist accuracy: measure the hand in 3D, not its shadow

The grab gate used only the normalised 2D landmarks. That projection is the
problem: when the hand is edge-on, or a balled fist hides its fingertips behind
the palm, the MCP-to-PIP bone collapses and the tip-to-MCP span no longer tells
you whether the finger is extended. A genuinely closed fist could score below
the 0.55 gate and never grab.

`finger_curls_3d()` now measures the same anatomical ratio on MediaPipe's metric
**world landmarks**, which are rotation-invariant, and `fist_pose` prefers them
whenever all four fingers are measurable. The 2D path remains the fallback. The
front band's outer edge was widened from 2.6 to 3.5 face widths; the 0.75–1.15
dead zone is unchanged.

The Gestures readout now shows both `fingerCurls` (2D) and `fingerCurls3d`, so a
real fist can be diagnosed rather than guessed at.

### Scrolling: thumb + index + middle, ring and pinky open

`three_finger_pinch()` requires the middle tip to be near the thumb as well as
the index, and requires ring and pinky to stay open. That last part is what keeps
it distinct from a fist. `detect_pointer` checks it **before** the click path and
returns `scrolling` with `pinch=False`, so the left button is released on the
same frame the third finger arrives.

The machine accumulates vertical hand travel at 0.035 screen heights per notch
and emits `pointer.scroll` with a signed notch count. The Windows helper turns
that into `MOUSEEVENTF_WHEEL` (120 units per detent); a throw is not emitted when
a scroll ends the pinch.

### Grabbing the real window

The PowerShell helper now exposes `GetForegroundWindow`, `GetWindowRect`,
`SetWindowPos`, `IsZoomed` and `EnumWindows`. A `window.grab` asks it for a target:
the foreground window, or the topmost other visible titled window when ORBIT
itself is focused (ORBIT's PID is skipped). A maximised target is restored first.
The main process records the grab origin and moves the window from pointer-frame
deltas, so it follows the hand 1:1 instead of jumping. Opening the fist,
`gesture.reset`, lost tracking, disarm, stop and error all end the move.

The helper's C# compiles and prints `READY` (verified standalone). The virtual
desktop available to this shell has no interactive window, so a throwaway window
could not be created to exercise `SetWindowPos` end to end; that needs the user's
desktop.

### Verified

- `python services/gestures/tests/test_gesture.py` — **187 passed, 0 failed**
  (new tests cover 3D fist recovery, scroll detection, scroll direction, and
  click suppression).
- `node packages/server/test/pairing.test.mjs` — **15 passed, 0 failed**.
- `npm run typecheck` clean.
- Helper script standalone: compiles and prints `READY`.

**Not verified:** a real fist's 3D curl values, the exact scroll step, and moving
a real window with the hand. The Gestures readout's two curl rows exist for the
first; the scroll step and window drag are the first two things to try live.

---

## 2026-11-11 (thirteenth pass) — the mirror swapped left and right, so the wrong hand was tracked

Reported as: "It detects my left hand as right and right as left", plus
"grabbing windows with my fist doesn't work yet".

### Root cause: MediaPipe's handedness was taken from the mirrored frame

`tracker.py` mirrors the camera frame with `cv2.flip` before inference so the
preview and the pointer's x-axis match the user. The code then assumed
MediaPipe's *legacy Solutions* convention ("handedness assumes a mirrored
input"), so it did **not** swap the labels. The Task API is the opposite: its
docs state handedness describes the subject's hands and that "passing a
horizontally mirrored image will invert these outputs".

So the user's right hand arrived labelled `Left`. `pick_hand_index` correctly
refused it, the pointer followed the left hand, and every right-hand fist was
treated as "no hand" — which is why grabbing never fired. The pointer moving at
all made this look like a gesture bug rather than a labelling one.

`swap_handedness()` now exchanges the labels immediately after extraction, with a
regression test that also exercises the end-to-end selection. `handLabel` in the
status stream is the corrected, physical label.

### Grabbing from the Gestures page

The renderer's source list was only populated by the Workspace page. After a
fresh launch, opening Gestures first meant `sources` was empty and a grab failed
with "No window to grab yet" — even for a perfect fist. The grab handler now
enumerates windows on demand when the list is empty, so the gesture works from
any page. The page also says **"Fist — hold it in front of your chest"** when the
hand is closed but outside both distance bands, instead of just "Fist".

### Verified

`python services/gestures/tests/test_gesture.py` — **168 passed, 0 failed**;
`node packages/server/test/pairing.test.mjs` — **15 passed, 0 failed**;
`npm run typecheck` and `npm run build` clean. After relaunch the live service
still reports `phase: armed`, `armed: True`, and the settings remain
`version: 2` / `true`.

**Not verified:** the corrected handedness and the real distance band still need
a person in front of the webcam. The Gestures readout now shows `handLabel`
(the physical hand), `distance`, `curl` and `reason` for exactly that check.

---

## 2026-11-11 (twelfth pass) — the pointer moved, but every click was silently disarmed

Reported as: "Only the movement of the pointer takes place but left clicking by
pinching or grabbing active windows don't work." The user also asked whether
mouse control depended on an iPad, and whether there was an arm switch.

### Root cause: a persisted `false` that nothing could show or change

The gesture machine returns an empty event list while `armed` is false, but
`serve.py` broadcasts pointer frames *before* that gate. So the cursor moved at
30 Hz while every `pointer.press`, `window.grab` and dictation event was thrown
away — exactly the reported split. The live service confirmed it: `armed: False,
phase: inactive`.

The value came from `gestureArmedByDefault` in the user's `settings.json`. The
code default had since become `true`, but settings merge the stored value over
the defaults, and there had never been any UI to change it. So an old default
disabled the feature permanently.

### Arming is now explicit and visible

- A settings v2 migration adopts the armed default once, because a stored
  `false` from before the toggle existed cannot have been a user choice. A
  deliberate disarm after v2 is still respected across restarts.
- The Gestures page has an **Enable hand control** checkbox. It calls the same
  arm/disarm commands and persists the choice alongside them in the main
  process, so a camera restart does not quietly re-arm after the user turned it
  off. Pointer frames now carry `armed`; while disarmed the main process stops
  moving the real cursor too, so the switch is a true master control rather than
  a filter that only disabled clicks.
- The renderer no longer re-arms from a startup value on every `running` state;
  the main process owns that decision and reads the live preference.

### Right hand only

`pick_hand_index` used to fall back to index 0 when the right hand was absent,
so a lone left hand could drive the cursor. It now returns `None` unless the
requested hand is present, and `serve.py` always requests `Right` rather than
following a label captured by an older calibration. Status carries
`handDetected`/`rightHand`, and the page says "Left hand only — use your right"
instead of looking broken.

### One fist rule for grabs and pinches

`detect_fist` classified "curled" with the average of all four fingers while the
pinch gate used middle/ring/pinky only. A loose cup with a partly extended index
could therefore look open to the grab path while looking like a fist to the
pinch path. Both now use `fist_pose()`, and a regression test pins the loose-cup
case.

### No iPad required

With no receiver connected, a gaze that points at where the iPad would be now
falls back to the laptop for the pointer stream, pinch presses and window
grabs/releases. Previously the OS cursor stopped, a pinch press returned before
pressing the real button, and a grab could be attributed to a tablet that was
not there. Mouse control never depends on pairing.

### Verified

`python services/gestures/tests/test_gesture.py` — **161 passed, 0 failed**;
`node packages/server/test/pairing.test.mjs` — **15 passed, 0 failed**;
`npm run typecheck` and `npm run build` clean. The settings migration was exercised
against a temp copy of the old file: it repairs `false` to `true` once, writes
`version: 2`, and a later deliberate `false` survives a reload. The live service
was queried read-only before the fix and reported `armed: False`, confirming the
diagnosis. After a full relaunch the same query reports `phase: armed`,
`armed: True`, and the real settings file has migrated to `version: 2` with the
preference `true` — so the running service is armed, not just the source.

**Not verified:** real-hand pinch/fist thresholds and the left-hand-only case
still need the webcam and a person; no iPad was available for the receiver
fallback.

---

## 2026-11-11 (eleventh pass) — the camera was blocked by a hidden leftover, and a pinch was vetoed by the fist gate

Reported as: "No app is currently using my camera but the app doesn't start it
saying some other app could be using the camera."

### Root cause: an orphaned gesture service

The Python service is a child process, and a force-quit or crashed ORBIT can
leave it running. It is invisible — no window, no tray icon — but it still owns
port 8790. The next launch saw the port busy and retried forever; the only text
the Gestures page had for *any* failure was "Check that no other app is using
it", which pointed at Zoom or Teams instead of the leftover.

`GestureBridge` now reaps a stale service before waiting on the port. On Windows
it asks `Get-NetTCPConnection` who owns 8790, verifies via `Get-CimInstance` that
the command line is our `serve.py`, and only then `taskkill`s it. A program that
merely happens to use 8790 is never touched. During the camera-busy backoff it
also scans for a Python process running `serve.py` that no longer owns the port,
because that process may still hold the webcam handle.

### Interpreter selection

`findPython()` returned the first name on PATH without checking it. A machine
with 3.10 (packages installed) and 3.13 (no packages) could therefore spawn a
service that dies on import, which looked like a camera failure. It now runs
`import mediapipe, cv2, websockets` against each candidate and uses the first
that succeeds. `ORBIT_PYTHON`, which the launcher has already probed, is still
trusted.

### Honest error text

The 30-second connect timeout used to claim "The camera may be in use by another
app" whenever nothing else was known. That was a guess presented as a diagnosis.
It now says the service did not start and quotes the service's own last error.
The renderer subscribes to `orbit:ev-gesture-state`'s `error` field, so a failure
that happens after launch reaches the banner and the Gestures preview instead of
being reduced to a generic sentence. The tracker itself tries DirectShow, Media
Foundation and the default backend, twice each, before reporting that Windows
returned no usable stream.

### A natural pinch no longer looks like a fist

`detect_pointer` vetoed a pinch when the *average* curl of all four fingers
crossed 0.55. Pinching curls the index by definition, and many people curl the
middle finger with it, so a genuine pinch could average above the gate and never
press. The gate now ignores the index and requires middle, ring and pinky to be
closed — `fist_pose()`. A real fist still curls all three, so it still releases
the button and still grabs; the new regression test pins both halves.

While there, two duplicated constant assignments were removed: the intended
raised gains (3.5/3.8) and smoothing (0.30) were being shadowed by the old
values above them, which is why the calibration test expected 2.5. The test now
matches the gain that actually runs.

### QR join reaches standby

The real browser flow was exercised end to end against an isolated server and a
desktop stub, over both `127.0.0.1` and the LAN address the QR actually uses:
scanning `#c=<code>` reached `.standby` with the clock on the first sample, no
console errors.

The LAN run first produced a blank page. The cause was real, not the harness:
`crypto.randomUUID` is only defined in a secure context, so the receiver threw
during its first render on plain HTTP (`ORBIT_NO_TLS=1`, a desktop-only debug
path) and never mounted. `loadDevice` now builds the same UUID from
`getRandomValues`, which works in an insecure context, so that path renders too.
The iPad's own QR uses HTTPS and was unaffected, but the debug route should not
look like a dead app.

**Files changed:** `packages/desktop/src/main/gestures.ts`,
`packages/desktop/src/renderer/App.tsx`,
`packages/desktop/src/renderer/pages/GesturesPage.tsx`,
`services/gestures/orbit_gestures/tracker.py`,
`services/gestures/orbit_gestures/geometry.py`,
`services/gestures/tests/test_gesture.py`,
`packages/receiver/src/lib/link.ts`.

### Verified

- An orphaned `serve.py` was started on 8790; a fresh bridge logged "Stopped a
  stale gesture service", reaped it, and reached `running` in 4.9 s with the
  camera open.
- `python services/gestures/tests/test_gesture.py`: **157 passed, 0 failed**.
- `node packages/server/test/pairing.test.mjs`: **15 passed, 0 failed**.
- `npm run typecheck` and `npm run build`: clean.
- Headless desktop harness: overlay/system-pointer/toggle/DOM-click/tablet-relay
  checks all pass.
- Headless failure injection: the banner, Gestures preview and sidebar all show
  the real "Could not open camera 0…" reason, and the old "another app" sentence
  is gone.
- Real browser against an isolated server: the QR join reached `.standby` on
  both loopback and the LAN address, with the clock and no console errors.

### Not verified

- A physical iPad (camera permission over self-signed HTTPS, MediaPipe load,
  gaze handoff, hold-drag) — still hardware-blocked.
- A genuine second application holding the webcam. This machine's driver lets
  two OpenCV processes open the same device, so the reaper's port path was the
  one exercised; the camera-holder path is reasoned, not reproduced.

---

## 2026-11-10 — Pinch-click fix + pointer sensitivity

### Root cause: gesture machine never armed
`gestureArmedByDefault: true` existed in settings but nothing called `gestures.arm()` when the service came up. The machine stayed in `INACTIVE` phase forever — pointer moved (that path runs before the armed check) but every gesture event was silently dropped. Pinching looked detected in the UI because the status frame still showed `pinch: true`, but `pointer.press` was never emitted.

**Fix** (`packages/desktop/src/main/ipc.ts`):
```ts
if (state === 'running' && settings.prefs.gestureArmedByDefault) gestures.arm();
```
Added to the `'state'` handler so the arm command is sent the moment the WebSocket confirms the Python service is live.

### Pointer sensitivity
Raised `POINTER_POSITION_GAIN_X` 2.5→3.5, `POINTER_POSITION_GAIN_Y` 2.7→3.8, reduced `POINTER_SMOOTHING` 0.45→0.30 in `geometry.py`. A comfortable hand sweep now covers the full screen; cursor feels less laggy.

**Files changed:** `packages/desktop/src/main/ipc.ts`, `services/gestures/orbit_gestures/geometry.py`
**Build:** ✓ clean

---

## 2026-11-10 (tenth pass) — the pinch is a held button, and the iPad runs its own camera

Reported as: "A pinch should click and keep holding, so I can drag or select.
The iPad should track my hand and eyes itself. When I look at it, the laptop
should stop controlling the pointer and the iPad should take over. The same hand
cursor must work there."

### A pinch was a single click, so nothing could be dragged

The ninth pass turned a settled pinch into one `pointer.click`. That is enough
to press a button, but it is the wrong shape for a mouse: a selection collapsed
the instant it opened, a window could not be dragged, and a slider could not be
moved. A real mouse is a down, a hold, and an up.

The gesture machine now emits `pointer.press` after `pinch_settle_ms` and holds
the button down until the fingers open, which emits `pointer.release`. The
settle delay is still there so a finger passing the thumb does not click.

The safety paths matter more than the happy path. A held OS button outlives the
gesture that opened it unless something deliberately closes it, and a desktop
stuck in a drag looks like a broken machine. So the button is released on hand
loss, disarm, service stop or error, a gaze change to the iPad, and turning the
`systemPointer` preference off. The release uses the last known pointer position,
so the up lands where the down was rather than at 0,0. Disarming also releases a
grabbed window as a **cancel**: it stays where it is instead of being routed by
whatever the head happened to be pointing at when gestures were switched off.

The main process keeps its own `osPressed` flag, separate from Python's. Either
side can end the drag — the Python machine on a dropped hand, Electron on a
service crash or a tablet takeover — and both must be able to send an unmatched
up harmlessly. The PowerShell helper gained `D`/`U`; `dispose()` writes `U\nQ`
so quitting mid-drag cannot leave the whole desktop with the left button down.
Its startup queue still coalesces movement but preserves button transitions in
order, because dropping a press or its release is what creates a phantom drag.
Movement is only sent when the target pixel actually changes. An earlier version
re-asserted the same position every 250 ms so the hand could reclaim the pointer
after the physical mouse moved it; that pulled the cursor back while the user was
reaching for the mouse, so the hand now reclaims on its next movement instead. A
physical mouse remains usable throughout and can even drag while a pinch is held.

With `systemPointer` off, the renderer fallback now synthesises
`pointerdown`/`mousedown` on the element under the cursor and only activates it
if the up lands on the same target. That keeps the in-app path behaving like a
mouse instead of clicking whatever happens to be under the release point.

Window grabs and dictation are gated by the effective owner. A grab that starts
while the iPad owns control is dropped, so a hand the iPad is tracking cannot
create a phantom laptop panel that then has to be cleaned up.

### The iPad could not see, so it could never take over

Until now the iPad only mirrored the laptop's hand cursor. That fails in exactly
the situation the feature exists for: once the user turns to the iPad, the
laptop's webcam loses their face or hand, so the cursor they are looking at
stops moving. The iPad needs its own camera.

`packages/receiver/src/lib/tablet-tracking.ts` now runs MediaPipe Tasks Vision
on the iPad itself. Camera frames are decoded in Safari and never cross the
network. Only a pointer position, a press/release, and a boolean "the user is
looking at me" are sent. The WASM runtime and the hand/face models are copied
into `packages/receiver/public/mediapipe` by `scripts/prepare-mediapipe.mjs` at
`predev`/`prebuild` and served by the ORBIT server at `/mediapipe/`, so the iPad
does not need an internet connection or a second copy of the models.

The camera can only start from a real tap; Safari refuses `getUserMedia`
otherwise, and the model load is far too slow to hide behind a startup effect.
A small tracking chip in the top-right is both the start button and the status
light: off, starting, tracking, turned away, or an error with Retry. It stops
automatically if the iPad is no longer paired, so a camera never stays on for a
session that has gone away. The `<video>` that feeds MediaPipe is attached to
the document at 2×2 px because iOS only decodes frames for an attached video
that is not `display: none`; it is detached on stop, and every failure path
releases the camera and any half-built landmarkers before the Retry appears.

The local mapping mirrors the camera image, learns its neutral point from the
first eight palm samples, and uses the same gain, smoothing and jump guard as
the laptop. Pinch uses the same hysteresis and fist gate, and press-hold-release
matches the laptop exactly. Head yaw within 25° means "looking at the iPad";
turning further away, or a face too small or absent, produces `null` rather than
a guess. An iPad that never starts local tracking still falls back to the
existing relayed laptop pointer.

### Who owns the pointer

A new `receiver.gaze` message carries the iPad's opinion to the laptop, which
relays it as `server.gaze.tablet`. The desktop keeps it for 2.5 seconds. The
resolver prefers that live opinion, then the gaze the Python service attached to
the event, then the last pointer frame; an explicit `null` means "no decision"
and stays on the laptop. When the iPad takes over, the laptop releases the OS
button immediately and stops moving its cursor. A release always lifts the
laptop button for safety, but is only relayed to the iPad if the matching down
went there, even if the head moved mid-drag.

New protocol envelopes: `receiver.gaze`, `server.gaze.tablet`,
`server.pointer.down`/`up`, and `desktop.pointer.down`/`up`, with matching hub
allowlist and relay entries. `pointer.click` is still accepted as a legacy
one-shot so a stale service build clicks rather than doing nothing.

### Verified

- `npm run typecheck`, `npm run build`, and `python
  services/gestures/tests/test_gesture.py`: **146 passed**. New tests cover
  press-on-settle, release-on-open, a release carrying the pointer position,
  two pinches pressing twice, hand loss releasing, and disarm releasing the
  pointer and cancelling a held window.
- `node packages/server/test/pairing.test.mjs`: **15 passed**.
- Real Windows helper, not a simulation: `press(420,320)` held the physical left
  button down through a 900 ms wait; a held move to `(520,380)` kept it down; a
  duplicate press did not produce a second down; `release()` lifted it and a
  duplicate release was a no-op. `dispose()` while pressed left the button up.
  A DPI-aware `GetCursorPos` probe confirmed the exact physical coordinates at
  125% scaling.
- iPad gaze relay driven by two protocol stubs: `true`, `false`, and `null`
  arrived as `server.gaze.tablet` unchanged, and a malformed `"yes"` became
  `null` instead of being trusted as "looking at the tablet".
- The server on an isolated port served the MediaPipe WASM as
  `application/wasm`, the model as `application/octet-stream`, both with a
  one-day cache; `/r` returned the app; a traversal attempt returned 404. The
  receiver build contains `dist/mediapipe/wasm` and `dist/mediapipe/models`.
- The tracking chip was run in the real built receiver: it rendered without
  touching the camera, the "Enable hand tracking" tap produced the permission
  error, the full message wrapped instead of truncating, and Retry was present.
  Screenshot checked at 1280×720.

**Not verified:** a physical iPad and a real hand. The iPad-side MediaPipe path
has never loaded a model on Safari, so WASM SIMD support, the GPU→CPU fallback,
self-signed-HTTPS camera permission, model download time, real pinch/fist
accuracy, the 25° yaw threshold, and the feel of a 30 Hz hold-drag are all
reasoned from the code, not measured. Headless Chromium in this environment
blocks loopback WebSockets (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`), so
the browser run could not pair or relay gaze; the relay was verified with
protocol stubs and the UI with a screenshot instead. That block is a harness
limitation, not something seen in Safari.

---



Reported as: "Enable pinch to click. And currently the cursor only works within
the app. I want it to work across the entire system."

### Why it could not leave the window

The cursor was a `<div>` positioned inside the ORBIT renderer. It could select
panels and click controls because the renderer synthesised DOM events under it,
but every other application on the machine was invisible to it: a browser that
was not ORBIT, Explorer, a game, or any window behind ORBIT could never be
clicked. Drawing a second cursor on top of the real one was the limit of that
design.

### A real OS pointer, owned by the main process

The renderer cannot move the system pointer, and Electron has no API for it, so
the main process now owns a small persistent PowerShell helper
(`main/system-pointer.ts`). It P/Invokes `SetCursorPos` and `mouse_event` from
`user32.dll`; one helper is spawned lazily for the life of the app with a
`READY` handshake. Spawning PowerShell per frame would cost about a second, so
the helper stays alive and reads a line per movement/click from stdin. It also
switches its thread to per-monitor-v2 DPI awareness: Windows otherwise
virtualises cursor coordinates for a DPI-unaware process, and at 125% scaling
asking for physical `(420, 320)` actually placed the pointer at `(525, 400)`.

The Python service emits a separate `type: "pointer"` stream at 30 Hz, distinct
from the 12 Hz status snapshot. It carries the smoothed hand position, whether
the hand is visible, pinch state, and the gaze target. The main process maps the
normalised position onto the display containing the ORBIT window with
`screen.getDisplayMatching` + `screen.dipToScreenPoint`, so a scaled or offset
second monitor still gets physical pixels. React never re-renders for these
frames.

A pinch is now a real left click in whatever app is under the cursor. The
service annotates `pointer.click` with the gaze target: looking at the laptop
clicks the OS pointer; looking at the iPad relays the click to the receiver
instead, so the shared window is not clicked twice. Clicks performed while the
head is between screens fall back to the laptop, matching where the cursor was
last shown.

`systemPointer` is a new preference, default on, with a Gestures-page toggle and
a diagnostics row. With it off, the old in-app overlay and DOM click path are
still used, so the feature can be disabled without losing gesture control inside
ORBIT. Turning it on hides the overlay to avoid two cursors. The physical mouse
is untouched: the helper only moves the pointer while a hand is visible and the
head is not on the iPad, and pauses when no hand is in view.

The eighth pass's fist/pinch separation is unchanged: a fist still releases an
existing pinch rather than clicking on the way into a grab, and a pinch is still
not classified as a front fist.

### Verified

- `npm run typecheck` and `npm run build`.
- `python services/gestures/tests/test_gesture.py`: 137 passed.
- `node packages/server/test/pairing.test.mjs`: 15 passed.
- Real Windows test, not a simulation: the helper moved the actual cursor to
  `(420, 320)` and `(500, 360)`, and a per-monitor-v2 DPI-aware `GetCursorPos`
  confirmed both at 125% display scaling. It then clicked a maximised WinForms
  window at `(500, 400)`; the window's click handler fired and wrote its result
  file. The original cursor position was restored afterwards.
- Python annotation check: a `pointer.click` while the router is on the iPad
  is annotated `gaze: tablet`; on the laptop it is annotated `gaze: laptop`.
- Electron runtime check at the same 125% scaling: the primary display reports
  1536×864 DIP, and `screen.dipToScreenPoint` maps its centre to physical
  (960, 540) on the 1920×1080 panel, which is where the helper now moves the
  cursor.
- Headless browser against the built desktop bundle, both modes: with
  `systemPointer` on, no in-app cursor was drawn and a pinch did not click the
  DOM (the main process owns that click); with it off, the overlay appeared,
  moved, hid on the iPad, returned on the laptop, a pinch clicked the DOM
  control under it, and a tablet pinch was relayed with `click: true`. An
  explicit null gaze still clicked locally instead of inheriting a stale tablet
  target. The Gestures toggle wrote `{"systemPointer":true}`. Zero application
  console errors (the only 404 was `favicon.ico`).

**Not verified:** real-hand tracking over the webcam, the feel of a 30 Hz OS
cursor under MediaPipe jitter, pinch-click reliability on a physical hand, the
iPad relay with a real receiver, and display mapping on a second physical
monitor. Those need the hardware; the Windows helper itself was exercised on
the real desktop.

---

## 2026-11-10 (eighth pass) — every hand was a fist; gaze without calibration; a second cursor

Reported as: "The gestures always read fist in front. Even when I am pinching or
just putting my hand in front. And how will you detect whether I am looking at
my laptop or iPad? Enable the same tracking on iPad. Also make the cursor
actually work on the laptop — keep the existing mouse pointer but add this as a
second pointer controlled by the fingers."

### Why every hand was a fist

`finger_curl` compared each fingertip's distance from the wrist with the distance
from the wrist to the finger's **PIP** joint, then mapped a 1.9..1.1 ratio onto
0..1. That band was correct for an MCP, not a PIP: a normal open hand measured
around 0.75, above the 0.55 gate, so the grab detector fired for anyone who
merely raised a hand. A pinch made it worse, because the folded index pulled the
average toward "closed" and the same hand was reported as a front fist.

The measurement is now taken entirely inside one finger: tip-to-MCP over
MCP-to-PIP, averaged across index, middle, ring and pinky. An extended finger is
roughly twice its proximal phalanx (ratio ~1.9); a closed one folds the tip back
under 0.65. Because both points are in the same finger, distance from the camera
and edge-on hands cancel out instead of corrupting the ratio. The index can fold
for a pinch while the other three stay open, so a pinch is no longer a fist.
`detect_fist` and `detect_pointer` still share the one 0.55 gate.

### Which screen the head is on

The webcam lives in the laptop, so facing the laptop is yaw ~0 and the iPad is a
large turn to either side. Without any setup the router now treats
`|yaw| <= 12°` as the laptop and `|yaw| >= 22°` as the iPad; the 12-22° dead zone
holds the last decision. Recording "Look at laptop" and "Look at iPad" still
works and refines the split for a laptop that sits off-axis or an iPad close to
straight ahead, but it is no longer required before a release can route. The
Gestures page shows the live target, the current mode, and the yaw.

### A second pointer

The hand cursor is now drawn inside the desktop renderer as well as the receiver.
It appears whenever a hand is visible and the head is not turned to the iPad,
and it works alongside the normal OS mouse rather than replacing it. A pinch
activates whatever is under it: panels are selected through the workspace, and
buttons, links and inputs receive a real DOM click, so the app can be driven
without touching the mouse. On the iPad the same cursor is relayed only while
the head is turned that way, with the same click behaviour.

### Verified

- `npm run typecheck` and `npm run build`.
- `python services/gestures/tests/test_gesture.py`: 137 passed, including
  realistic anatomical hand fixtures for open hand, fist, and pinch-not-fist.
- `node packages/server/test/pairing.test.mjs`: 15 passed.
- Headless browser against an isolated server on 8887/8888: a relayed pointer
  drew the iPad cursor at the expected position, a relayed pinch selected the
  panel under it and clicked the real Interact tab, and hiding the pointer
  removed the cursor. Zero console errors.
- Headless browser against the built desktop bundle (with a preload stub): the
  laptop cursor appeared at the reported hand position, moved with it, hid when
  the gaze target became the iPad, and returned on the laptop without any
  calibration. Zero application console errors.

**Not verified:** real-hand accuracy of the new curl ratios and gaze thresholds,
and the feel of a second cursor on the physical laptop/iPad. Those need the
webcam and hardware, not a simulation.

---

## 2026-11-10 (seventh pass) — a fist stops clicking; pairing has one button

Reported as: "Whenever I try to grab a window by making a fist in front of me it
detects it as a pinch. And when I connect my iPad there are two buttons, Connect
and Reconnect. The Connect button doesn't work; only Reconnect works."

### Why the grab clicked

A fist rests the thumb beside the curled index tip, so thumb-to-index distance is
small and the pointer's pinch test said "click" at the exact moment the user was
trying to grab. The two detectors were using different definitions of a closed
hand: `detect_fist` had a 0.55 curl threshold, while `detect_pointer` had none.

`geometry.py` now has one shared `FIST_CURL_THRESHOLD = 0.55`. `detect_pointer`
measures `finger_curl` first and returns `pinch: false` with `reason: "fist"` for
any hand at or above the gate, before the pinch hysteresis runs. A hand that
closes into a fist therefore releases an existing pinch instead of clicking on
the way in. The curl fixture also got a realistic index PIP, so the test exercises
the same joints MediaPipe reports.

### Why Connect did nothing

The screen had two buttons: `Connect` submitted the six digits, and `Reconnect
now` called the socket reconnect path. When the prefilled code was stale, Connect
sent a code the server had already burned and came straight back rejected, while
Reconnect appeared to "work" only because it reopened the socket with no code.

Now there is one primary button. A complete code shows **Connect**; an empty or
partial form shows **Reconnect**, which skips the retry backoff. `join()` always
opens a fresh socket after storing the code, so pressing Connect cannot reuse a
half-open or already-burned connection. Rejection copy tells the user to scan the
QR again for a fresh code.

A deeper reason the old Connect looked dead: a scanned QR code can already be
burned (it was used by the initial auto-join, or it belongs to an earlier
session). Reconnect "worked" because it skipped the code and resumed with the
device id, while Connect resubmitted the dead code. The receiver now does that
fallback itself: if a paired device has a code rejected as `bad-code` or
`code-expired`, it retries once with an empty code, resuming by device id. If the
laptop no longer knows that id (`no-session`), it stops and shows the code entry
form, so there is no reject/retry loop.

### Verified

- `npm run typecheck` and `npm run build`.
- `node packages/server/test/pairing.test.mjs`: 15 passed.
- `python services/gestures/tests/test_gesture.py`: 128 passed, including
  `test_fist_is_not_a_pinch`.
- Headless browser: an invalid prefilled code shows exactly one **Connect**
  button; clearing the cells turns it into **Reconnect**; entering the live code
  and pressing Connect reaches the standby clock; a reload resumes as
  **Connected** with no console errors.
- Headless browser, stale-code path: pair with the live code, then reload the page
  with that now-burned code and again with `000000`. Both land on the standby
  clock as **Connected**, never showing the pairing form, and log no errors.

### Not verified

Real-hand behaviour on the webcam and the physical iPad. The curl gate is
unit-tested against a synthetic fist, and the button flow is simulated against
the real server, but neither replaces holding a fist in front of the camera.

---

## 2026-11-10 (sixth pass) — the iPad can trust the socket; the QR code fills the form

Reported as: "It keeps saying that it can't get access to the laptop on my iPad,
and when I scan the QR code it should automatically input the code."

### The page loaded, the socket did not

I reproduced everything on the laptop: `GET /r` over `https://192.168.8.201:8787`
returned the receiver, and a `wss://` client using the same address, origin and
LAN IP paired successfully. The firewall allowed both 8787 and 8788 on every
profile, the certificate's SAN matched the current DHCP address, and the hub's
origin check accepted the iPad's origin. In other words, none of the server-side
theories explained it.

The remaining failure shape is specific to iOS. Safari lets a page load through
the per-site certificate exception and then refuses the `wss://` upgrade to the
same host, so the UI is visible and the receiver reports that it cannot reach the
laptop. A self-signed **leaf** certificate makes that worse: iOS only offers
"full trust" for a certificate that is marked as a CA, so installing the old
`receiver.cert.pem` could not fix the socket either.

### A local CA, and a leaf that follows DHCP

`packages/server/src/tls.ts` now generates two things:

- a long-lived local CA (`ca.key.pem`, `ca.cert.pem`, `basicConstraints cA:true`,
  `keyCertSign`), stored beside the existing files in `%USERPROFILE%\.orbit`;
- a server leaf signed by that CA (`receiver.key.pem`, `receiver.cert.pem`) with
  `serverAuth`, the current LAN IP, `127.0.0.1` and `localhost` in its SAN.

The HTTPS listener serves leaf + CA. When the laptop's address changes, only the
leaf is re-signed; the CA remains, so an iPad that trusted it once stays trusted.
A leaf signed by an older CA, expired, or missing the current IP is regenerated
on startup, with a console line saying so.

`GET /cert` now returns the **CA** on both listeners. The plain-HTTP port is
deliberate: the download must work before the HTTPS side is trusted. The pairing
screen shows an **Install certificate** button when the socket is offline, and
the Setup page prints the same URL with the iOS trust steps (Settings → General →
About → Certificate Trust Settings → ORBIT Local CA).

### The QR digits are visible now

Scanning already auto-joined; when that join could not reach the laptop the
fallback pairing screen was blank, which looked like the scan had done nothing.
`link.ts` now exposes the boot code it read, `PairingScreen` prefills the six
cells from it, and a single **Connect/Reconnect** button retries without waiting
for the retry backoff. (A seventh pass replaced the temporary second button.) The
code is cleared on welcome, so a later session end does not show a burned code.

The launcher already freed 8787; it now frees 8788 as well, and the server warns
loudly if the plain-HTTP listener cannot bind. An orphan holding 8788 put the
desktop on a different hub while the iPad joined the new one, which also presents
as a pairing code that never matches.

### Verified

- `npm run typecheck` and `npm run build`.
- `node packages/server/test/pairing.test.mjs`: 15 passed.
- `python services/gestures/tests/test_gesture.py`: 127 passed.
- From the laptop, over the real LAN address: HTTPS `/health` and `/cert` return
  200 when the served CA is trusted, the leaf verifies against the CA, and a
  `wss://` client with that CA reaches the hub (`no-session`, as expected with no
  desktop running).
- The old cached leaf was refused and re-signed on startup; the regenerated leaf
  has the current IP and the CA has `cA:true`.

### Not verified

Installing the profile and enabling trust on a physical iPad. The server side is
now correct and the app tells the user exactly what to install; whether iOS shows
the trust toggle for a given profile still needs a real device.

---

## 2026-11-10 (fifth pass) — QR pairing stops hanging; grab, look and release moves a window

Reported as: "When I tried connecting to my iPad, I scanned the QR and it was
stuck on the loading page. Make it load properly and default to a standby clock.
When I grab a window, if I look at the laptop and let go nothing should happen,
but if I look at the iPad and let go the window should transfer. My hands should
work on whichever screen I am looking at."

### Why the QR scan hung

Two faults pointed at each other.

`PairingScreen` auto-joined from `location.hash` in an effect. That effect ran
while the *first* WebSocket was still opening, so `join()` saw no open socket
and called `connect()` again. The join attached to whichever socket won, and the
other socket's `onopen` then wrote `unpaired` over the top. On a fast laptop this
raced invisibly; on an iPad it looked like an infinite loading page.

The other half: `connect()` blindly wrote `connecting` on every retry and had no
guard against opening a second socket, so a retry mid-join reset the state the
spinner depended on.

Fixes in `packages/receiver/src/lib/link.ts`:

- The hash code is read **once, at module scope, before the first socket
  exists**, and sent by that socket's own `onopen`. A QR scan therefore joins on
  the first connection. The pairing screen no longer auto-joins.
- `connect()` returns if a socket is already connecting or open, every socket
  handler checks that it is still the current socket, and a detached close
  cannot schedule a retry or overwrite newer state.
- The code is kept until a welcome or an explicit rejection. Clearing it as soon
  as the hello was written lost the join when the reply was delayed or the
  component remounted (StrictMode also exercises that path).

### Reconnect no longer needs a burned code

A paired iPad that loses Wi-Fi has no pairing code: the code is single-use and
was rotated the moment it joined. `ManagedSession.joinReceiver` now accepts an
empty code from a **known device id** and resumes that receiver's identity. The
hub keeps a disconnected receiver record for 30s (`markReceiverOffline`), but
`SessionInfo` only lists receivers with a socket, so the desktop is not told an
absent iPad is live. The existing 90s sweep remains a backstop.

The desktop side got the same treatment: `startDesktop` reuses a session when
the same desktop device id reconnects, `attachDesktop` moves it to the new
socket without dropping receivers, and a 10s grace prevents a one-second blip
from orphaning the iPad. A reconnect also reuses a still-live pairing code
instead of rotating the QR out from under the user.

A **reload** is a cold start, not a socket drop, so the receiver now persists a
`orbit.receiver.paired` flag beside the device id. With it set and no code in the
URL, the page opens in `reconnecting` and offers the device id; the clock (with
"Reconnecting") is shown instead of the six-digit screen, which the user could
not complete because the iPad never held a code. A rejected resume clears the
flag and returns to pairing with the server's explanation.

### Standby by default, panels per device

`Panel.ownerDeviceId` is now the routing rule. `undefined`/`null` means the
panel lives on the laptop. The receiver filters the workspace to panels owned by
its own stable device id; with none left it shows the clock instead of an empty
canvas. A freshly grabbed window is laptop-owned, so it cannot appear on the
iPad until a release actually sends it there.

### Grab, look, release

The Python service already had head-pose yaw and a `GazeRouter`; nothing was
consuming it. Now:

- `GazeRouter.release_target()` returns a destination only when the two anchors
  are calibrated and the head is currently on one side. Calibration is two
  explicit looks ("Look at laptop", "Look at iPad") saved to
  `gaze_calibration.json`; anchors closer than 6° are rejected rather than
  saved half-working. Smoothing, a dead zone and a 320ms dwell stop a glance
  from committing; 700ms of no face forgets the decision.
- `window.release` carries `detail.gaze` (`laptop`, `tablet` or `null`).
- On `window.grab` the desktop creates or selects a panel for the active source
  (laptop-owned) and sends no video.
- On release: `tablet` assigns the panel to the first connected receiver and
  starts its sender; `laptop` stops the sender and clears the owner; `null`
  leaves everything untouched and explains why. Looking at the laptop when the
  panel is already there is a genuine no-op.
- Automatic share-on-connect is gone. Connecting an iPad no longer pushes a
  window on its own.
- A fast pinch release still produces `window.throw` in the gesture service, but
  the desktop no longer routes it: a throw used to pick a destination by
  direction, and now the gaze decides. Treating it as a move would transfer a
  panel as a side effect of clicking on the iPad.

### Hands follow the gaze

The gesture service's status already included a normalised hand pointer. The
desktop now relays it as `desktop.pointer` while the head is on the iPad, and a
pinch becomes `desktop.pointer.click`. The hub broadcasts both; the receiver
draws a cursor at those viewport coordinates and, on a pinch, selects the panel
under `document.elementFromPoint` (panels expose `data-panel-id`). Looking at
the laptop hides the cursor. This is still not OS-level mouse control.

### Also fixed

`serve.py` had a syntax error where `broadcast()` and its first `if` had been
merged onto one line, so the gesture service could not start at all.
`gaze.py`'s `_as_rows` rejected a flat 16-element matrix before reshaping it,
which is a form MediaPipe hands back; a new test caught it.

### Verified

- `python services/gestures/tests/test_gesture.py` — **127 passed**. New tests
  cover yaw/pitch extraction, flat matrices, unusable anchors, calibration
  round-trip and bad files, dwell, dead zone, lost-face grace and
  `release_target`.
- `node packages/server/test/pairing.test.mjs` — **15 passed**. New coverage for
  pointer relay, receiver resume with no code and desktop reconnect without
  losing the session or rotating the live code. The harness now sets
  `ORBIT_NO_TLS=1`, which it always needed for its plain HTTP/WS client.
- `npm run typecheck` and `npm run build` pass.
- **Not verified on the physical iPad or with a real hand in this pass.** The
  protocol and state machines are covered; the threshold and camera behaviour
  are not.

---

## 2026-11-10 (fourth pass) — Orientation aiming abandoned; the cursor follows the hand again

Reported as: "Even now after calibration it isn't able to point toward the right
side or top right of the screen. Maybe we should adopt a different approach? The
way it was originally I had to move my hand around to move the cursor. If this
hand tilting detection is not possible revert it back to the previous method."

### Why orientation aiming could never work

The screenshot gave `palm facing -0.25, 0.03, -0.97` and `pointer 0.49, 0.31`.
Backing the calibration out of those numbers puts the neutral aim at
`(-0.251, +0.143)`, so the palm had moved **0.007** in tan-x across the entire
session. To reach the right edge it would have had to move 0.333 — about 18°.

That is not a tuning problem, it is anatomy. A palm held facing the camera
**cannot be yawed by the wrist**:

* pronation/supination spins the palm about the camera axis, which does not
  change where it points at all;
* radial and ulnar deviation spins it about its own normal, which also does not;
* the only way to yaw a palm is to swing the whole forearm from the elbow or
  shoulder.

So the vertical axis worked (wrist flexion is easy and does change pitch) while
the horizontal axis was simply unavailable — which is exactly the reported
symptom: stuck left, right side unreachable. The three earlier passes were all
fighting this one fact, and the calibration only made the stuck position
symmetrical.

### Reverted to a position pointer

The cursor now follows the palm centre's position in the frame, scaled up around
a calibrated centre. This is a trackpad, not a laser pointer, and it uses the
axis the hand is actually good at.

| Constant | Value | Why |
|---|---|---|
| `POINTER_POSITION_GAIN_X` | `2.5` | ±0.2 of the frame — a comfortable sweep — covers the whole screen width. |
| `POINTER_POSITION_GAIN_Y` | `2.7` | Vertical travel is shorter than horizontal, so it needs a little more. |
| `POINTER_SMOOTHING` | `0.45` | Landmark position is far steadier than a derived normal, so the filter can stay light. |

The anchor is unchanged: the midpoint of the index and pinky knuckles, which is
rigid under finger flexion (so a pinch does not drag the cursor) and invariant
under roll (so rolling the hand is not a move).

### What was removed

`ray_to_screen()`, `aim_of()` and the `AimCalibration` aim maths are gone. The
palm normal is still computed and still shown as "Palm facing", but only as a
diagnostic — it drives nothing.

`pointer_anchor()` lost its knuckle-line roll term and its vertical gain. Those
were workarounds for making the fallback behave like an aim, and with position
as the mapping they were double-counting.

### Calibration now means "where is the middle"

`PointerCalibration` stores the palm centre in normalised image coordinates,
which is what the cursor is actually derived from. The button is now **Centre
cursor**: hold your hand where you want the middle of the screen, press it, done.

A `calibration.json` written by the aim-based version is rejected rather than
reinterpreted — those numbers are tangents of palm angles, and treating them as
image coordinates would put the cursor in a corner. `from_dict` checks the range
as well as the keys for that reason.

### Verified

106 tests pass, rewritten around the position contract: the cursor follows the
hand on both axes, ±0.2 of the frame reaches the edges, a 4% hand move is a 10%
screen move, rolling the hand does not move the cursor, a wobbly middle knuckle
does not move it either, world landmarks cannot leak into it (they are
hand-centred and carry no absolute position), an edge-on palm still works, and
calibrating off-centre keeps both edges reachable.

Not verified on hardware — no camera or MediaPipe in this environment.

---

## 2026-11-10 (third pass) — Cursor parked in the bottom-left; no way to calibrate

> **Superseded:** the calibration below works, but it was calibrating the wrong
> thing. Orientation aiming was abandoned in the entry above because the wrist
> cannot yaw a palm that faces the camera, so no amount of centring makes the
> sides of the screen reachable.

Screenshot showed `pointer 0.19, 0.70`, `palm facing -0.20, 0.12, -0.97`, and
`tracking hand: left`.

### The maths was right; the input was biased

Recomputing by hand: `aim = (-0.206, +0.124)`, i.e. the palm reads as aimed
**11.7° left and 7.1° down**, and `0.5 + aim × gain` gives exactly `0.19, 0.71`.
So the projection was doing what it was told — the *palm normal itself* was
offset.

That offset is systematic, not noise. MediaPipe's world landmarks put the wrist
behind the palm plate and bias the depth estimate, so a hand held squarely at
the screen still reads as aimed several degrees off. At a screen-sized gain,
twelve degrees is most of the screen. And no gain value can fix a constant
offset: turning the gain down makes the cursor sit near the middle but makes it
insensitive again, which is precisely the loop the last two passes were stuck
in.

### Fix: real calibration, not more gain tuning

`gesture.calibrate` had been a placeholder since the gesture service was built.
It now works:

* `AimCalibration` (geometry) stores the neutral aim as `tan yaw`, `tan pitch`,
  plus the handedness label that was visible.
* `aim_of()` factors the raw aim out of `ray_to_screen()`, so the same
  measurement is used for both reading and calibrating.
* `ray_to_screen(..., calibration=)` subtracts the neutral aim before scaling.
  The user's neutral pose now maps to dead centre; everything else is measured
  relative to it.
* The service captures the pose from the **latest frame** when the request
  arrives (`gesture.calibrate` → `_calibrate()`), saves it to
  `services/gestures/calibration.json`, and resets the smoother so the cursor
  lands on centre instead of sliding there.
* A "Calibrate aim" button on the Gestures page, plus an "Aim calibration" row
  that says whether it has been done.

Verified against the exact pose in the screenshot: before calibration
`(0.191, 0.711)`, after `(0.500, 0.500)`, and ±15° from that pose reaches
`0.098` / `0.902` — symmetric and still responsive.

### The handedness label disagrees with its documentation

The panel read `left (right preferred)` for what the user calls their right
hand. MediaPipe documents that handedness assumes a mirrored input, which
`cv2.flip` provides, so the label should have been `Right`. It was not.

Rather than guess a convention and be wrong for half the users, calibration now
also records *which* label was being tracked, and the service prefers that label
afterwards. The label stops being something the code has to be right about.

### Note on holding a fist while pointing

The screenshot showed `curl 0.68` — the hand was closed. The palm plane is built
from the wrist and the two outer knuckles specifically because those are rigid
under finger flexion, so a fist and an open palm give the same normal. That part
is fine, but calibration should still be taken with the hand in the pose it will
actually point in.

### Verified

129 tests pass. New coverage: calibration centres the captured pose, preserves
relative movement (an offset, not a rescale), round-trips through JSON,
rejects a corrupt file, and refuses to calibrate from an edge-on palm.

---

## 2026-11-10 (later) — Pointer aimed backwards and would not move

Reported as: "It is supposed to look for my RIGHT PALM and trace a line
perpendicular from the palm's centre and project it on the screen. It is not at
all pointing at the intended direction. If anything it is pointing in the
opposite direction and that also is not sensitive enough."

Four independent faults, all in the pointer path.

### 1. The palm plane was built from three nearly-collinear points

`palm_frame()` took the index, middle and pinky MCP knuckles. Those three sit
almost on one straight line across the palm, so the triangle they form has an
area of ~2 mm² and its normal's *direction* was decided by a 2 mm difference in
y — the same magnitude as MediaPipe's own landmark noise. The normal therefore
pointed somewhere different every frame, and often backwards.

The plane now uses the wrist plus the two outer knuckles (index and pinky MCP):
a real triangle ~9 cm by 6 cm, roughly 25x the area, so the normal's direction is
set by the pose instead of by noise. A `PALM_PLANE_MIN_AREA` guard rejects frames
where the landmarks collapse onto a line.

This was the biggest single cause: even with the sign conventions right, a
normal derived from a degenerate triangle cannot aim anywhere consistent.

### 2. x was negated on a false premise

The previous entry in this log concluded that world landmarks are in the
camera's *unmirrored* frame and negated `pos_x`/`aim_x` to compensate. That is
wrong: `cv2.flip` runs **before** the frame is handed to MediaPipe, so the model
sees a mirrored image and its world landmarks are mirrored with it. Negating x
turned a correct mapping into an inverted one — the "opposite direction" symptom.
The negation is gone and both axes now map straight through.

### 3. The position term was measured in a frame that has no position

`hand_world_landmarks` are metric 3D coordinates with **the origin at the hand's
own centre**. So `origin.x` was always within a couple of centimetres of zero,
`POINTER_NEUTRAL_ORIGIN` was meaningless, and the position contribution was
effectively a constant. The cursor was being driven by the orientation term
alone, at an effective gain of about 0.44.

The position term is gone entirely. The pointer is now a pure orientation device,
which is what was asked for: a ray out of the palm along its normal.

### 4. The right hand was never selected

`num_hands=1` meant MediaPipe returned whichever hand scored highest — often the
resting left one. Now two hands are requested, handedness is carried through
`FrameResult.hand_labels`, and `pick_hand_index()` chooses the **Right** hand
whenever it is in frame. The status message reports `handLabel`, and the preview
shows a "Tracking hand" row, so a wrong-hand situation is visible rather than
mysterious.

### Sensitivity

The projection is now the physically correct one: projecting onto a plane at
distance D divides by D *and* by the plane's width, so D cancels and what remains
is `tan θ` of the palm's tilt. The gains are therefore plain screen-fractions per
unit of tan, with no arbitrary "virtual screen distance".

| Constant | Before | After | Why |
|---|---|---|---|
| `POINTER_GAIN_X` | `0.5 × 2.5` (≈0.44 effective) | `1.5` | 18° of tilt now reaches the edge instead of 49°. |
| `POINTER_GAIN_Y` | same | `1.7` | A 16:9 screen is shorter than it is wide, so vertical needs a little more. |
| `POINTER_POSITION_GAIN` | `1.2` | removed | It multiplied a number that was always ~0. |
| `POINTER_SMOOTHING` | `0.35` | `0.45` | The higher gain also amplifies noise; slightly more filtering keeps it usable. |

`POINTER_GAIN` remains the single master multiplier to turn if this now feels too
twitchy or too sluggish.

### Also fixed

An edge-on palm used to fall through to the 2D `pointer_anchor` fallback, which
is a *position* mapping in different units — the cursor teleported to wherever
the hand was in the frame for a frame or two. With world landmarks present the
ray is now the only mapping, and a refused frame reports nothing so the smoother
holds. The fallback is only for when the metric landmarks are missing entirely.

### Verified

- 116 deterministic tests pass (up from 92 passing / 8 failing on arrival).
- The 8 failures on arrival were all the *old* position-based pointer tests,
  which correctly failed once the pointer stopped following hand position. They
  were replaced with the orientation-only spec: sliding must not move the cursor,
  a flat palm holds dead centre from anywhere in the frame, and ±20° of yaw or
  pitch reaches the edges.
- New regressions: a 3 mm wobble on the middle knuckle must not move the cursor
  at all (it used to swing the normal by tens of degrees); a left palm and a
  right palm facing the same way must aim the same way; a 5° turn must move the
  cursor at least 8% of the screen.
- Simulated a realistic right-hand pose: yaw −20° → x = 1.00, +20° → x = 0.00,
  neutral → 0.50, and rolling the palm about the camera axis does not move the
  cursor at all (correct — roll does not change where the palm points).
- Not verified on hardware: no camera or MediaPipe install in this environment,
  so the handedness label assumption rests on MediaPipe's documented convention
  (labels assume a mirrored selfie image, which `cv2.flip` provides).

---

## 2026-11-10 (earlier) — Pointer always drifted left; cursor sluggish / unresponsive

> **Correction:** the diagnosis below is wrong, and acting on it is what caused
> the "points in the opposite direction" bug fixed in the entry above. MediaPipe
> sees the *already mirrored* frame, so its world landmarks are mirrored too and
> must not be negated. The tuning table is superseded as well; the position term
> it strengthens was measuring a coordinate that is always ~0.

### Root cause: world landmark x-axis is unmirrored

`cv2.flip(frame, 1)` mirrors the *image* before it reaches the UI preview, but
MediaPipe's `hand_world_landmarks` are computed in the camera's native (unmirrored)
coordinate frame before that flip. The old comment in `ray_to_screen()` said x
"already matches the user's left/right" because the frame was mirrored — this was
wrong. In world space, moving the hand to the **user's right** produces a **negative**
x (the camera sees it on the left). The result was that every rightward move pushed
the cursor left, and the bias landed the cursor near the left edge of the screen.

**Fix**: negate both `pos_x` and `aim_x` in the final formula inside `ray_to_screen()`.

### Secondary fixes: responsiveness and tuning

| Constant | Before | After | Why |
|---|---|---|---|
| `POINTER_MAX_JUMP` | `0.33` | `0.55` | Old value blocked real fast sweeps (a hand can easily cross 1/3 of the screen in one frame). |
| `POINTER_SMOOTHING` | `0.45` | `0.35` | Lighter filter = less lag, more responsive feel. |
| `POINTER_POSITION_GAIN` | `1.0` | `1.2` | More lateral travel maps to more cursor travel. |
| `POINTER_RAY_SCALE` | `2.2` | `2.5` | Wider virtual screen = less wrist tilt needed to reach edges. |
| `POINTER_MIN_FACING` | `0.18` | `0.15` | Slightly more permissive angle before the edge-on hold kicks in. |
| `POINTER_NEUTRAL_HIT/ORIGIN` | `(0.008, -0.074)` | `(0.0, -0.07)` | Recentred after the x-negation; previous offset was measuring the wrong-sign frame. |

Verified with deterministic unit tests (no hardware): all four movement directions
(user right/left, up/down) now produce the expected cursor direction.

---

## The cursor is aimed by hand orientation, not hand position

Requested as: "doesn't move the pointer according to the movement of the hand but
according to its orientation... even if I tilt my hand it should move the
cursor".

So the cursor now behaves like a laser pointer or TV remote. The hand is held
roughly in view and **tilted** to aim; sliding the whole hand sideways leaves
the cursor where it is.

New `hand_orientation()` derives two angles from rigid palm landmarks, so finger
flexion cannot disturb them:

* **roll** — slope of the index-knuckle-to-pinky-knuckle line. Level knuckles are
  neutral; rolling the hand aims left or right.
* **pitch** — wrist position relative to the knuckles. An upright hand reads
  about -1.67, and tipping toward the floor lowers it further.

Both are divided by the palm's own width, so the reading does not change when the
user sits closer to or further from the laptop.

Two calibration points found by measuring the geometry rather than guessing:

* The upright-hand pitch is **-1.67**, not the +2.0 first assumed — the wrist sits
  roughly 1.7 palm-widths below the knuckles.
* Pitch needed its own gain (0.9 vs roll's 1.4). A comfortable wrist bend spans
  about 2.5 pitch units but only about 0.3 roll units, so sharing one gain made a
  small tilt slam the cursor into the top or bottom edge.

Pitch is negated when applied: tipping down drives the pitch reading down, but
"down" on screen is a larger y.

Verified against synthetic poses: neutral aims at the centre; +-15 degrees of
roll aims 0.14 / 0.86; tipping gives 0.20 / 0.80; and moving the hand to x=0.35,
0.50 or 0.65 leaves the cursor at exactly 0.50. 82 tests pass, including new ones
for position independence and size independence. The eight position-based
pointer tests were replaced — they correctly failed once position stopped
driving the cursor.

Trade-off: holding a hand at a constant angle needs some wrist discipline, and
there is no way to "park" the cursor without relaxing the hand. If it proves
tiring, the usual fix is a small dead zone at the neutral pose.

---

## The cursor drifted while pinching

Symptom: "when I pinch the cursor moves because it follows my index finger".

Correct diagnosis, and the suggested fix (track the middle finger instead) is
close but not quite it — the middle fingertip also shifts when the thumb presses
across the hand. The real problem is that *every* fingertip moves during a pinch,
because closing a thumb-to-index pinch physically drags the index tip inward.
The cursor was anchored to `HAND_INDEX_TIP` and `POINTER_GAIN` (2.5) multiplied
that movement into a visible lurch on every click.

New `pointer_anchor()` returns the midpoint of the index and pinky knuckles — the
palm centre. That is rigid under finger flexion, so it stays put while the pinch
opens and closes, and it is anchored on two joints rather than one so a noisy
landmark cannot swing it. The wrist was rejected as an anchor: it swings a lot on
forearm rotation.

Trade-off worth knowing: the cursor now follows the whole hand rather than the
pointed finger, so it feels more like moving a hand than aiming a finger. That is
the intended reading, since the pinch is the click.

Tests: added "pinching does not move the cursor" and "curling the fingers does
not move the anchor", which fail on the old fingertip anchor. Measured zero drift
while the pinch registers. 74 passed. Direction, screen reach and throw/flick
detection tests all still pass.

---

## Pointer was inverted, and could not reach the screen edges

Two separate bugs in the pointer path, both reported from actually using it.

**Inverted.** `tracker.py` already mirrors the frame (`cv2.flip`) *before*
MediaPipe runs, so landmark x is in the user's left/right frame. `GesturesPage`
then flipped it a second time in the preview mapping
(`px = ox + (1 - x) * rw * scale`) while the pointer dot used `x` unflipped. The
skeleton and the dot therefore disagreed, and dragging left moved the dot right.
Both now use the same unflipped mapping. The docstrings claiming "already
mirrored" were themselves the trap, so they now say who does the mirroring and
that nothing else may.

**Too small a reachable area.** `pointer_position` mapped the raw fingertip
`[0, 1]` straight to the screen. A hand cannot comfortably cover the whole
camera frame, so in practice only the middle of the screen was reachable. Added
`POINTER_GAIN` (2.5) and `POINTER_CENTER` (0.5), which amplify movement around
the frame centre: at 2.5 a comfortable 0.30-0.70 hand sweep spans the full range,
so the corners are reachable. Still clamped to `[0, 1]`.

Tests: the two assertions that encoded the old 1:1 mapping were replaced, and
new tests pin the things that actually broke — direction is not inverted, a 40%
hand sweep spans the screen, and gain really does amplify. 70 passed.

---

## The renderer port is now a preference, not a requirement

Symptom: the launcher printed "freeing port 5173" and then "it just stopped".
The app refused to start because 5173 was busy.

Three separate causes, all fixed:

1. `RENDERER_PORT` was hardcoded and treated as mandatory. If `freePort()` could
   not reclaim it the launcher called `fail()` and `process.exit(1)`. There is
   now a preferred port (`ORBIT_RENDERER_PORT`, default 5173) and
   `pickRendererPort()` walks up to 20 ports past it, using whichever is free.
2. The port was baked into three places that could disagree: the launcher, the
   `dev` npm script (`vite --port 5173` / `wait-on tcp:5173`), and
   `vite.config.ts`. The launcher now chooses one port and passes it to
   everything as `ORBIT_RENDERER_PORT` / `ORBIT_RENDERER_URL`; the `dev` script
   forks `packages/desktop/tools/dev.mjs`, which reads that single value for
   Vite, wait-on and Electron alike.
3. A cross-family bind made "port taken" unobservable. A foreign server on
   `0.0.0.0:5173` does not stop Vite binding `[::1]:5173`, so both servers
   served "port 5173" and Vite cheerfully reported ready. The dev tool now runs
   the same both-families bind probe the launcher uses before starting Vite, and
   steps to the next port if either family is taken.

`freePort()` still kills leftovers on 8787/8788, but the launcher deliberately
no longer reclaims 5173: that port is a dev-server convention, so the likely
holder is someone else's Vite and killing it would be rude. It moves aside
instead.

Also hardened: `tools/dev.mjs` retries the next port (up to 10) if Vite still
cannot bind, where previously a clash became "the desktop app exited with code
1" and took the whole app down.

Verified by holding 5173 with an unrelated HTTP server and running
`npm run start:fast`: output read `5173 is in use by something else; using 5174
instead.`, then `ORBIT is running.`, with the Electron window titled ORBIT.
`http://localhost:5173` still answered the foreign server and
`http://localhost:5174` answered ORBIT. `npm run typecheck` clean.

---

## Self-healing when the port or camera is held

**Date:** 2026-11-10
**Scope:** `packages/desktop/src/main/gestures.ts`, `services/gestures/serve.py`

### What was wrong

If the gesture service could not bind 8790 — a predecessor still dying, a leftover
`serve.py`, another ORBIT — the bridge retried twice on a 2.5 s budget and then
settled on `failed` permanently. The only recovery was reopening the app. The
user's exact complaint: make it fix itself instead of making me load the app
again.

### What it does now

- **`portIsFree()`** probes 8790 with a throwaway `net.createServer` before every
  spawn, so a spawn into a known-busy port is no longer attempted.
- **`spawnWhenPortFree()`** polls for the port to free instead of assuming it
  has. Previously this timed out into `fail()`; it now routes into the busy
  cycle.
- **`scheduleBusyRetry()`** backs off 1.5 s × n, capped at 4 s, and keeps going
  rather than running out of budget. After 8 tries it tells the user once what
  it is waiting for, and *keeps retrying in the background*.
- `serve.py` now prints a single recognisable line (`cannot bind port` /
  `port already in use`) and exits non-zero, rather than a bare traceback.
- A camera-open failure now also exits non-zero instead of staying alive with the
  port bound. That zombie was worse than a crash: the desktop connected
  successfully and reported a dead service as `running`.

### Three bugs found while testing it

1. **`BUSY_RE` did not match the message `serve.py` actually prints.** The regex
   looked for `address already in use`, but the script emits `cannot bind port`,
   so port conflicts were classified as generic crashes and went straight to
   `fail()`. This is the one that would have made the whole feature look broken.
2. **The 30 s connect timeout fired during a healthy wait.** Nothing was spawned
   while the port was blocked, so `connect()` had nothing to attach to and
   declared failure. It now stands down while a busy cycle is active.
3. **Two paths scheduled retries for the same failure** and cancelled each other,
   producing a `failed` → `starting` flicker. `retryQueued` plus `busyCycle` make
   only one retry exist at a time.

### Verified

`npm run typecheck` clean. Real app over CDP, no app reload, no button press:

- port held for **40 s**: state stayed `starting` for the whole block, with no
  `failed` flicker at any sample;
- on release: `running` within **5 s**;
- an earlier 60 s hold behaved the same (blocked 60 s, then recovered).

Not verified: a real Zoom-style webcam conflict, which needs another process to
own the camera while ORBIT tries to open it. The port path and the camera path
share `scheduleBusyRetry`, but only the port path was exercised.

---

## Restart camera

**Date:** 2026-11-10
**Scope:** `packages/desktop/src/main/gestures.ts`, `main/ipc.ts`, `shared/ipc.ts`,
`preload/index.cjs`, `renderer/pages/GesturesPage.tsx`, `services/gestures/orbit_gestures/tracker.py`

### Why

Windows gives a webcam to one process at a time, so after Zoom/Teams held the
device the only fix was restarting ORBIT. The Gestures page now has a **Restart
camera** button.

### The bug the first attempt had

`restart()` initially just called `stop()` and then spawned. That is wrong here:
`stop()` leaves `stopping` set, so the *outgoing* child's `exit` handler runs
after the replacement is already up and (a) calls `setState('stopped')` and (b)
`closeSocket()`, killing the new service's socket. Symptom was a restart stuck on
"Starting the camera…" forever — and it was masked, because a `python serve.py`
process *was* alive and bound to 8790 while the UI showed "Camera off".

Fixed with a private `killChild()` that closes the socket, **detaches the old
child's `exit`/`error` listeners** so its exit is inert, then forces the tree down
on Windows. `restart()` no longer goes through `stop()` at all, and a
`stopToken` counter lets a genuine `stop()` (app quitting) cancel a pending
restart so the app does not spawn a service on its way out.

### Also improved

The camera error text named only the Windows privacy settings, which is the wrong
first guess when the real cause is another app holding the device. `tracker.py`
now says so explicitly and points at the new button.

### Verified

`npm run typecheck` / `npm run build` clean. Real app over CDP:

- button present, labelled `Restart camera`;
- one press: `Camera on` → `Camera starting…` → `Camera on` with live
  `640×480 · 1 fps` about 7.5 s later;
- three presses back to back all recovered at ~7.5 s, no drift;
- `serve.py` process count stayed at exactly **1** after the three restarts, so
  the teardown does not leak orphans.

Not verified: a genuine "another app holds the webcam" conflict. That needs
something to actually own the device during the test.

---

## Camera starts with the app, not with the iPad

**Date:** 2026-11-10
**Scope:** `packages/desktop/src/renderer`, `services/gestures/serve.py`

### What changed

The camera used to start only when a receiver connected, and stopped the moment
it went away. That made the Gestures preview dead exactly when someone would
open it to check the detector. Now the service starts once on launch and runs
for the whole life of the app; `window-all-closed` / `before-quit` still stop it,
so the camera is never left running.

**Detection never needed arming.** `MouthGestureMachine.update()` returns early
when `armed` is false, but the frameloop computes landmarks, pointer and phase
regardless — so the preview and the gesture readout work whether or not anything
is armed. Arming only decides whether a recognised gesture *acts*. The renderer
now honours `gestureArmedByDefault` (default flipped to `true`) instead of
unconditionally arming on connect, and the pref is read before the service
starts so the decision cannot race it reaching `running`.

The page no longer infers camera state from the receiver count. `camera` is
passed through `SharedProps` as the real service state and gained a `failed`
case, so the empty preview says "camera starting" / "camera failed" instead of
claiming the iPad needs to connect.

### The bug this surfaced

With the camera always on, the preview footer read **1000000 fps**. `fps` was
`1 / (now - frame_start)`, where `now` is sampled microseconds before the status
block, so the divisor rounded to ~1e-6 and the clamp turned into the reported
number. Replaced with a smoothed frame-to-frame interval (85/15 EMA) capped just
above `MAX_FPS`.

`Reason=no face` while a hand is visible is **not** a bug: `detect_fist` needs a
face to measure the mouth-distance bands, so with a hand and no face the honest
reason is that the fist gestures cannot be evaluated. `Hand / face = yes / no`
reports it correctly at the same time.

### Verified

`npm run typecheck` and `npm run build` clean. Then the real app over CDP with
**no iPad paired or connected at all**:

- sidebar chip read `Camera on` while the link chip read `Reconnecting`;
- the Gestures tab showed `640×480 · 29.9 fps`, phase `armed`, frame counter
  climbing — live MediaPipe output with nothing paired;
- holding a hand up produced `Pinch (0.27) | Open hand` → `Open hand` →
  `Pinch (0.37) | Open hand`, painting 1538–1664 canvas pixels, then dropping to
  `Face only` with 885 pixels of face mesh when the hand left frame;
- fps stayed 27–31 across the run after the fix.

---

## Restored the camera preview with joint mapping

**Date:** 2026-11-10
**Scope:** `packages/desktop/src/renderer`

### What was restored

The Gestures page came back as a third tab, after it was dropped during the UI
simplification. It is `pages/GesturesPage.tsx`, wired through `Sidebar.tsx`
(`PageId` gained `'gestures'`) and `App.tsx`.

### Why it was recoverable

Nothing upstream had been deleted, only the page that consumed it: the Python
service still emits `landmarks` for hand and face at 12 Hz, `gestures.ts` still
normalises them into `GestureStatus`, and `main/ipc.ts` still re-emits
`orbit:ev-gesture-status`. So no protocol or backend change was needed — the
renderer just subscribed to an event nobody was listening to any more.

### Decisions worth recording

**The preview draws landmarks, it is not a video feed.** The service never sends
frames; the canvas plots the 21 hand points and face mesh from coordinate data,
so the hours spent keeping video off this socket stay spent. The preview is
letterboxed to the camera aspect ratio and mirrored on X, matching how
`detect_pointer` already normalises the pointer.

**Hand bright, face dim.** The face is drawn thin and low-contrast because it is
context for the mouth/fist distance bands, not the subject. The hand is accent
coloured, fingertips are enlarged, and the palm centre — the anchor the curl
measurement uses — gets a ring that turns amber when the hand curls.

**Gesture names are ordered, not listed.** `curl`, `pinch`, `atMouth` and
`inFront` overlap on purpose, so `identify()` ranks the most deliberate one
first rather than showing contradictory badges at once.

### Verified

`npm run typecheck` clean, desktop build clean. Then the real app over the
Chrome DevTools protocol with the actual Python service running:

- nav reads `Setup | Workspace | Gestures`, the page mounted with both cards;
- live status arrived from MediaPipe — `640×480`, fps, phase `armed`, reason
  `no hand`, frame counter climbing, and a `tracking lost` event surfaced;
- the canvas was 528×395 device pixels and *empty* while no hand was in view,
  which is the correct result and proves it is not painting a fake skeleton;
- driving the component's exact draw code with a fabricated 21-point hand
  painted 2704 pixels (1.3% coverage) in the bone/tip/pointer positions.

Not verified: a real hand in front of the camera. The room was empty, so the
skeleton was exercised with synthetic points rather than a live hand.

---

## Gestures: pointer, pinch, throw — and a devlog

**Date:** 2026-08-11
**Scope:** `services/gestures`, `packages/shared`, `packages/desktop`

### What was added

| Gesture | Trigger | Emits |
|---|---|---|
| Cup at mouth | closed fist within 0.75 face widths, held 600 ms | `dictation.start` |
| Fist in front | closed fist 1.15–2.6 face widths, held 450 ms | `window.grab` |
| Pointer | open hand, index fingertip position | status only |
| Pinch to click | thumb–index closed for 60 ms | `pointer.click` |
| Throw | release a pinch while moving fast | `window.throw` |

### Decisions worth recording

**Curl before position.** The original detector fired on proximity alone, so any
hand near your mouth activated dictation. Now every gesture starts with a
*closed* hand check: each fingertip's distance from the wrist is compared with
that finger's middle joint. An open hand reads ~0.45, a fist ~1.0, and the
threshold is 0.55. Reaching, pointing or scratching your face does nothing.

**Non-touching distance bands.** A cup is ≤ 0.75 face widths, a front fist is
≥ 1.15. The gap is deliberate: moving between them is silent, so one continuous
motion cannot flicker between dictating and grabbing.

**Hysteresis on the pinch.** Pressing requires the thumb and index to come
within 0.45 hand-widths; releasing requires separating past 0.60. A single
threshold would chatter on the boundary and emit a stream of clicks.

**One pinch = one click.** The click fires when the pinch has been held
`pinch_settle_ms`, and does not repeat until the fingers open. Holding a pinch
is not a held mouse button.

**Throws are judged at release, not during movement.** Requiring a pinch
beforehand is what separates a throw from a hand that simply moves quickly
during normal gesturing. Direction must beat the other axis by 1.6× so a
diagonal wobble cannot claim a direction it did not travel in.

**A throw never silently drops a panel.** If there is no connected device, or
the only device already owns the panel, the app surfaces a message rather than
moving it somewhere the user did not choose.

### Bugs found while building this

1. **Falsy zero timestamp killed pinch-to-click.** The settle check was
   `now_ms - (self._pinch_since or now_ms)`. When pinching began at `t=0`,
   `_pinch_since` is `0`, which `or` treats as falsy, so the expression compared
   `now_ms` with itself and the elapsed time was always zero — the click never
   fired. In the real app pinching at any time near startup would have done
   nothing at all. Fixed to an explicit `is not None` check.

2. **Renderer duplicated `GestureStatus`.** The renderer had its own copy of the
   status type, separate from the main process, and silently drifted when new
   fields were added. Typecheck caught it; both copies now carry the same fields.

3. **`disarm()` read state after clearing it.** The grab-release branch checked
   `_grab_phase` after `_clear_holds()` had already nulled it, so disarming never
   reported the release. Now captured before clearing.

### Verified

- **66/66 unit tests pass** (up from 44). New coverage: pointer mapping and
  clamping, pinch hysteresis in both directions, size-independent pinch
  distance, throw direction/speed/diagonal-rejection/staleness, click-once
  semantics, click-again-after-release, and pointer tracking without a face.
- **Live camera run:** the service streamed real `pinch`, `pinchDistance`,
  `pointer` and `pointerReason` values from an actual camera (pinching at 0.45,
  open at 1.03), with no tracebacks.
- Typecheck clean across shared, server, desktop main, desktop renderer.

### Not verified

- **No testing with a real hand.** The curl threshold (0.55), the distance bands
  (0.75 / 1.15), the pinch thresholds (0.45 / 0.60) and the throw speed
  (0.9 screen-widths/second) are reasoned from geometry, not measured against a
  real user, room lighting or camera. All are single constants and will likely
  need tuning.
- **The throw → device mapping is not exercised against two physical devices.**
  `pickThrowTarget` is unit-testable but was not driven end to end with two
  paired iPads.
- **The pointer does not move the real Windows cursor.** It is an in-app cursor
  only, so it cannot click anything outside ORBIT.

---

## Gesture service: camera stuck on "Starting…"

**Date:** 2026-08-11
**Scope:** `packages/desktop/src/main/gestures.ts`

### Symptom

Pressing **Start camera** showed "Starting…" forever, while the laptop camera
indicator was lit — the camera had in fact opened.

### Root cause

The bridge made a single connection attempt immediately after spawning Python,
which needs ~2 s to load the MediaPipe models. The attempt lost the race, and
the retry was conditional on the state being `running`:

```js
if (this.state === 'running') this.scheduleConnectRetry();
```

Since the state was `starting`, a failed first connect was never retried. The
service was healthy and holding the camera; the UI just never learned about it.

### Fixes

- Retry whenever the service is meant to be coming up (`running` **or**
  `starting`).
- 30 s timeout that reports the last Python error instead of hanging silently.
- A **Cancel** button while starting — previously "Stop camera" was hidden, so a
  stuck user had nothing to click.
- `stop()` now kills the process *tree* on Windows: a Python process holding a
  camera handle often survives a plain `kill()`, leaving orphans bound to port
  8790 that a later launch could connect to.
- Stopping during a pending connect no longer throws an unhandled WebSocket
  error, which would have crashed Electron's main process.

### Verified

Real `GestureBridge` driven from a cold start reaches `running`; two full
start/stop cycles both succeed; `stop()` leaves zero orphaned Python processes;
rapid start/stop does not crash.

---

## One-command launcher

**Date:** 2026-08-11
**Scope:** `tools/launch.mjs`, `start.cmd`, `package.json`

Running ORBIT needed three terminals, the right working directory, and manual
recovery from stuck ports. Now `npm start` (or double-clicking `start.cmd`)
checks dependencies, picks the Python that actually has MediaPipe, rebuilds only
when sources change, frees stale ports, starts both processes, and stops
everything on Ctrl+C.

### Bugs found

- **`npm run dev:desktop` pointed at a file that did not exist.** `package.json`
  said `dist/src/main/main.js`; the build emitted `dist/main/main.js`. My earlier
  "build succeeded" had been reading a stale artifact — a passing build is not a
  launchable app.
- **Port detection was blind.** `netstat` sometimes shows no row for a process
  that still owns a port, so the launcher reported "did not become available"
  with no recovery path. Switched to `Get-NetTCPConnection`.
- **Free-port probe gave false "ok"s.** Binding without a host defaults to IPv6
  on Windows, so it reported a port free while IPv4 was held; the server then
  died with `EADDRINUSE`. Now probes `0.0.0.0` explicitly.
- **A second launch killed a running session** by stealing its ports. Added a
  lock; it now says "ORBIT is already running."
- **`npm run typecheck` was broken**, pointing at a non-existent
  `tsconfig.json`. Now checks desktop main and renderer separately.

**Not verified:** a genuine Ctrl+C in a real console window — programmatic
signals are not delivered on Windows, so the handler was tested by invoking it,
not by pressing the key.

---

## First gesture: hand near mouth

**Date:** 2026-08-09
**Scope:** `services/gestures`

MediaPipe hand and face landmarks run locally; when a fingertip came within
0.55 face widths of the mouth for 600 ms, it emitted a simulated dictation
start. 22 deterministic tests, no hardware required — geometry and the state
machine are pure and injectable.

Established the patterns still used now: normalise by face width so distance
from the camera does not matter, require a hold so a passing hand does nothing,
cancel rather than fire when tracking is lost, and keep every dismissal
available without a gesture.
