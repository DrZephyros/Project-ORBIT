"""Gesture state machine.

The outline is explicit that a gesture must not fire on a single lucky frame:
each recognition needs a hold duration, smoothing, a cooldown, and defined
behaviour when tracking is lost. This module owns that policy and knows nothing
about cameras or MediaPipe, so it can be tested deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# How long a freshly armed wheel must wait before its first notch.
#
# Arming is decided by travel, and the travel that arms the wheel is usually the
# hand being raised into position. One frame is enough to tell a sweep still in
# progress from a hand that has arrived and stopped, and it is short enough that
# no real sweep loses a notch.
SCROLL_CONFIRM_MS = 40


class Phase(str, Enum):
    """Mirrors the diagram in section 5 of the plan, reduced to what we use."""

    INACTIVE = "inactive"
    ARMED = "armed"
    APPROACHING = "approaching"
    LISTENING = "listening"
    COOLDOWN = "cooldown"


@dataclass
class GestureConfig:
    # How long a hand must be cupped near the mouth before dictation starts.
    hold_ms: int = 600
    # How long a fist must be held in front before the window is grabbed.
    grab_hold_ms: int = 450
    # How long after releasing before the gesture can fire again.
    cooldown_ms: int = 1500
    # Dropping a grabbed window and raising the fist again is one continuous
    # kind of interaction, not a fresh command, so it does not deserve the full
    # 1.5 s silence. The 450 ms hold is what stops an accidental re-grab.
    grab_cooldown_ms: int = 400
    # If tracking is lost mid-hold, how long we wait before resetting.
    lost_tracking_grace_ms: int = 400
    # How long a fist may drop out of the front band before the grab is let go.
    #
    # MediaPipe flickers `in_front` by a frame or two at the edge of the band.
    # Releasing on the first miss meant `window.grab` and `window.release` went
    # out in the same millisecond, so the window never moved at all. A held fist
    # survives this long; a lowered hand is still released promptly.
    grab_release_grace_ms: int = 300
    # Frames below this are treated as "no hand" even if a point was returned.
    min_confidence: float = 0.5
    # A pinch must persist this long before it counts as a click, so a finger
    # passing over the thumb does not click. Kept to a single frame: any longer
    # and a deliberate press feels like it is waiting for permission.
    pinch_settle_ms: int = 30
    # Speed (screen widths per second) a hand must reach for a release to be
    # treated as a throw rather than simply opening.
    throw_min_speed: float = 0.9
    # Vertical hand travel (screen fractions) per wheel notch while the
    # three-finger scroll is held. Raised from 0.06 to 0.10 on request: the page
    # moved too far for the amount of hand travel, so a small drift sent several
    # notches. Bigger number = less sensitive = more hand travel per notch.
    scroll_step: float = 0.10
    # A closed hand is a wheel only once it has *moved*. The three-finger scroll
    # and a real fist are nearly identical shapes on a live hand (both curl the
    # ring and pinky to about 0.6), so pose alone sent every grab into the wheel.
    # A fist held up to grab stays still, while a scroll is a deliberate sweep:
    # this much travel, inside `scroll_arm_ms`, turns the pose into a wheel.
    # Kept at 0.05: real sweep tests travel as little as 0.04 per gesture, and
    # raising it simply refused to recognise an ordinary scroll at all.
    scroll_arm_distance: float = 0.05
    scroll_arm_ms: int = 400
    # Cap one frame's burst. A tracking jump should not spin the page.
    scroll_max_notches_per_frame: int = 3
    # A single frame of phantom travel. Measured as speed, not distance: at the
    # 5-10 fps this laptop drops to under load, a normal hand sweep moves far
    # more than a fixed per-frame distance, and a per-frame cap silently threw
    # those sweeps away. That is why scrolling arrived about once a second.
    # Raised from 3.5 to 6.0 when the wheel was made less sensitive: reaching a
    # notch now takes more travel, so an ordinary deliberate sweep is faster, and
    # a 3.5 limit was discarding exactly the sweeps the user meant.
    scroll_max_speed: float = 6.0
    # A single frame where the pose flickers must not throw away the scroll
    # progress: the accumulator only reaches a notch after several frames of
    # travel, and resetting on every dropout meant a real sweep scrolled nothing.
    scroll_grace_ms: int = 250
    # Left-hand fist held out: horizontal travel (screen widths) per virtual
    # desktop, and a cooldown so one sweep cannot fly through the whole row.
    # Sideways travel per desktop switch, while the fist is held and moving. This
    # is the trackpad's slide: keep moving and you keep switching. 0.12 of the
    # frame is a comfortable arm movement between adjacent desktops; the old 0.20
    # made a single swipe cover almost the whole frame before anything happened.
    desktop_step: float = 0.12
    # Short, so a continuous sweep flows from one desktop to the next. It exists
    # only to stop a single physical movement being counted twice as landmarks
    # jitter across a step boundary.
    desktop_cooldown_ms: int = 120



@dataclass
class GestureEvent:
    """One state transition worth reporting to the UI."""

    kind: str
    phase: Phase
    message: str
    at_ms: int
    detail: dict[str, object] = field(default_factory=dict)


class MouthGestureMachine:
    """Detects "hand held near mouth" and emits start/stop style events.

    Safe behaviour on lost tracking: if the hand or face disappears while the
    user is holding, we do not fire. We reset after a short grace period so a
    single dropped frame does not cancel a deliberate hold.
    """

    def __init__(self, config: GestureConfig | None = None) -> None:
        self.config = config or GestureConfig()
        self.phase = Phase.INACTIVE
        self.armed = False
        self._mouth_since: int | None = None
        self._front_since: int | None = None
        self._grab_phase: int | None = None
        self._lost_since: int | None = None
        # When the hand first stopped making the gesture while a hold was open.
        # The release waits `grab_release_grace_ms` so a flickered frame cannot
        # cancel a deliberate fist.
        self._release_since: int | None = None
        self._cooldown_until = 0
        self._last_active = False
        self.fired_count = 0
        self.grab_count = 0
        # Pointer / pinch state. Kept here so hysteresis survives between frames.
        self.pinching = False
        self._pinch_since: int | None = None
        # True while the left mouse button we opened for this pinch is still
        # down. The click is press-on-settle / release-on-open, not a one-shot
        # click: a held pinch must drag and select exactly like a held mouse.
        self._pressed = False
        self._pressed_at: tuple[float, float] | None = None
        self._last_pointer: tuple[float, float] | None = None
        self.click_count = 0
        self.throw_count = 0
        self.pointer: tuple[float, float] | None = None
        # Three-finger scroll. Kept across frames so one continuous hand sweep
        # is a smooth stream of notches, not one notch per pinch.
        self.scrolling = False
        self._scroll_last_y: float | None = None
        self._scroll_last_ms: int | None = None
        self._scroll_accum = 0.0
        self._scroll_grace_until = 0
        self.scroll_count = 0
        # A closed hand is only a wheel once it has moved deliberately; see
        # `_arm_scroll`. Until then it stays a fist, so it can grab the window.
        self._scroll_armed = False
        self._scroll_pose_since: int | None = None
        self._scroll_anchor_y: float | None = None
        # When travel first exceeded the arming distance. Used to require the
        # movement to be sustained, so a fist settling into place does not arm
        # the wheel.
        self._scroll_move_ms: int | None = None
        # Since when an *armed* wheel has been sitting still. A fist settles into
        # position and then holds; a wheel keeps sweeping. This is what hands the
        # pose back to the grab path.
        self._scroll_still_since: int | None = None
        # When the wheel last armed. A wheel that has only just armed has not
        # been confirmed as a sweep yet, so it must not turn the page.
        self._scroll_armed_ms: int | None = None
        # Left-hand fist: horizontal travel switches virtual desktops.
        self.desktop_count = 0
        self._desk_anchor_x: float | None = None
        self._desk_cooldown_until = 0
        # Partial travel toward the next desktop, as a fraction of one step
        # (-1..1). Negative is left, positive right. Published so the UI can show
        # the slide in progress rather than a bare switch.
        self._desk_progress = 0.0
        # No "one switch per cup" state: the fist switches for as long as it keeps
        # moving, and the direction comes from the movement itself.

    @property
    def scroll_armed(self) -> bool:
        """Whether the current closed hand is a wheel rather than a fist."""
        return self._scroll_armed

    # -- per-frame update --------------------------------------------------
    def update(
        self,
        now_ms: int,
        at_mouth: bool,
        in_front: bool,
        hand_visible: bool,
        face_visible: bool,
        distance: float,
        confidence: float = 1.0,
        curl: float = 0.0,
        pointer: tuple[float, float] | None = None,
        pinching: bool = False,
        scrolling: bool = False,
        scroll_pointer: tuple[float, float] | None = None,
        left_fist: bool = False,
        left_pointer: tuple[float, float] | None = None,
    ) -> list[GestureEvent]:
        """Feed one frame. Returns any events produced by this frame.

        Two gestures share this machine because they cannot be active at the
        same time: a hand is either cupped at the mouth or held out in front.
        `at_mouth` and `in_front` are mutually exclusive by construction in
        geometry.detect_fist, which leaves a deliberate dead zone between them.
        """

        if not self.armed:
            # Not armed: the machine stays inert, but we still report the phase
            # so the UI can show why nothing happens.
            self.phase = Phase.INACTIVE
            self._last_active = False
            self._end_scroll()
            return []

        events: list[GestureEvent] = []

        # While a window is physically grabbed, the fist owns the hand: a balled
        # hand's thumb rests beside the index and every so often reads as a
        # pinch. Feeding that to the pointer path clicked and cleared the grab
        # mid-drag, and the next fist re-based the window, which is exactly why
        # dragging was glitchy and only worked once.
        grab_held = self._grab_phase is not None

        # Decide whether the closed hand is a wheel or a fist before the pointer
        # and grab paths look at it. Set still, it is a fist: the grab must win.
        #
        # `in_front` is passed in because *where the hand is* is the one thing
        # that reliably tells a grab from a wheel. A cupped fist held out in the
        # front band is the grab gesture; scrolling is done with the hand near
        # the chest, sweeping. Without this the travel of raising the fist into
        # the band armed the wheel, the grab branch was skipped, and the status
        # bar read "Scroll" while the user was trying to pick up a window.
        scroll_pose = bool(scrolling) and not grab_held
        self._arm_scroll(scroll_pose, scroll_pointer or pointer, now_ms)

        # Pointer and pinch run regardless of face visibility: aiming at the
        # screen does not require the face to be fully in frame.
        events.extend(
            self._update_pointer(
                now_ms,
                pointer,
                pinching and not grab_held,
                scrolling and not grab_held,
                hand_visible,
                confidence,
                scroll_pointer=scroll_pointer,
            )
        )

        # A left-hand fist held out switches virtual desktops, the way a
        # four-finger trackpad swipe does. It runs *before* the tracking gate and
        # independently of it on purpose: `tracking_ok` requires the right hand,
        # so folding this in behind that gate meant a right hand out of frame
        # reset the swipe anchor every frame. The desktop swipe then only worked
        # while the right hand happened to be visible, which is exactly the
        # reported failure. The two hands are independent gestures.
        # The reset must run even when the left hand has left the frame. Lowering
        # the hand *is* the release half of the gesture, and skipping the call
        # when `left_pointer` is None meant the cup never re-armed — which is why
        # the switch only worked about half the time.
        if left_pointer is not None:
            events.extend(self._update_desktop_switch(left_fist, left_pointer, now_ms))
        elif self._desk_anchor_x is not None:
            events.extend(self._update_desktop_switch(False, (0.0, 0.0), now_ms))

        tracking_ok = hand_visible and face_visible and confidence >= self.config.min_confidence

        if not tracking_ok:
            # Lost tracking. Hold the previous decision briefly, then reset.
            if self._lost_since is None:
                self._lost_since = now_ms
                events.append(
                    GestureEvent(
                        "tracking.lost",
                        self.phase,
                        "Lost tracking — holding." if self._active_hold() else "No hand in view.",
                        now_ms,
                    )
                )
            elif now_ms - self._lost_since > self.config.lost_tracking_grace_ms:
                if self._active_hold() or self.phase is Phase.APPROACHING:
                    events.append(
                        GestureEvent("gesture.reset", self.phase, "Tracking lost — gesture cancelled.", now_ms)
                    )
                self._clear_holds()
                self._end_scroll()
                self.phase = Phase.ARMED if self.armed else Phase.INACTIVE
                self._last_active = False
            return events

        self._lost_since = None

        if now_ms < self._cooldown_until:
            self.phase = Phase.COOLDOWN
            return events

        if self._grab_phase is not None:
            # The grab is already held. Keep it until the fist is genuinely gone
            # for the grace window, and let a flicker through without turning it
            # into a click or a scroll. `in_front` goes false on frames where the
            # fist is momentarily read as a pinch, so the grace is what makes the
            # drag continuous.
            if in_front:
                self._release_since = None
                events.extend(self._update_grab(now_ms, distance, curl))
            else:
                events.extend(self._release_after_grace(now_ms))
            return events

        if pinching or self._scroll_armed:
            # A pinch or an armed wheel outranks a grab.
            #
            # Touching thumb to index curls the fingers, so a pinching hand reads
            # as a *fist* to finger_curl — a relaxed open hand already scores
            # about 0.72 against a 0.55 threshold. Dispatching on `in_front`
            # first therefore sent every pinch into `_update_grab` and returned,
            # so `pointer.press` was never emitted and a pinch could never click.
            #
            # While a pointer gesture owns the frame the click/scroll path owns
            # it: the pointer is tracked and the button goes down (or the wheel
            # turns). The grab cannot start, because the user is pointing or
            # scrolling, not picking anything up.
            #
            # The *armed* flag, not the raw pose, is what counts here. Pose alone
            # cannot tell a scroll from a fist on a real hand, and using it sent
            # every deliberate grab into the wheel; a hand held still is a fist.
            self._clear_holds()
            self._release_since = None
            if self.phase is not Phase.COOLDOWN:
                self.phase = Phase.ARMED
            return events

        if in_front:
            # Grabbing takes priority over the mouth band: an outstretched fist is
            # unambiguous, and the mouth band is far away, so the two never both
            # apply.
            self._release_since = None
            events.extend(self._update_grab(now_ms, distance, curl))
            return events

        if at_mouth:
            # An active grab owns the hand.
            #
            # Reported: "Grabbing a window and moving it around doesn't function
            # reliably either." A fist held in front sits close to the mouth band
            # in projected space, so as the hand moved while dragging, single
            # frames landed inside the band. `_update_dictation` clears
            # `_front_since`, which ended the grab mid-drag - the window stopped
            # following the hand and the next frame had to start a fresh hold.
            #
            # Once a window is physically held, the grab keeps the hand until the
            # user actually opens it. Dictation cannot start from a hand that is
            # already dragging something.
            if self._grab_phase is not None:
                self._release_since = None
                return events
            self._release_since = None
            events.extend(self._update_dictation(now_ms, distance, curl))
            return events

        # Neither gesture this frame. Keep the hold through a short flicker, then
        # release it for real.
        events.extend(self._release_after_grace(now_ms))
        if self.phase not in (Phase.ARMED, Phase.COOLDOWN):
            self.phase = Phase.ARMED
        return events

    def _release_after_grace(self, now_ms: int) -> list[GestureEvent]:
        """Release a fist grab only after the gesture has been missing briefly.

        A single frame of MediaPipe noise used to end a grab instantly, and
        restart a 450 ms fist hold from zero. The mouth cup keeps its immediate
        release: dictation is a different interaction and never grabbed anything.
        """
        if self._mouth_since is not None:
            self._release_since = None
            return self._release(now_ms)
        if self._front_since is None:
            self._release_since = None
            return []
        if self._release_since is None:
            self._release_since = now_ms
            return []
        if now_ms - self._release_since < self.config.grab_release_grace_ms:
            return []
        self._release_since = None
        return self._release(now_ms)

    # -- pointer and pinch -------------------------------------------------
    def _update_pointer(
        self,
        now_ms: int,
        pointer: tuple[float, float] | None,
        pinching: bool,
        scrolling: bool,
        hand_visible: bool,
        confidence: float,
        scroll_pointer: tuple[float, float] | None = None,
    ) -> list[GestureEvent]:
        """Track the cursor and press/hold/release the mouse with the pinch.

        A press fires once the pinch has been held `pinch_settle_ms`, and the
        button stays down until the fingers open. That is what makes a pinch a
        real drag: holding it selects text and moves windows, and the release is
        the mouse-up the user expects. The settling delay stops a finger passing
        over the thumb from clicking.

        The three-finger pinch turns the wheel instead. It is handled before the
        click path so the left button is released on the very frame the middle
        finger joins, and the vertical travel of the hand is accumulated into
        notches.

        Any loss of the hand, or a disarm, releases the button. Leaving it down
        would leave the whole desktop stuck in a drag, so safety wins over
        trying to smooth over a dropped frame.
        """
        events: list[GestureEvent] = []

        self.pointer = pointer if hand_visible else None
        if pointer is not None:
            self._last_pointer = pointer

        if not hand_visible or pointer is None:
            events.extend(self._release_pointer(now_ms, "Hand left the frame."))
            self.pinching = False
            self._pinch_since = None
            self._end_scroll()
            return events

        if scrolling:
            # The third finger arrived: any click in progress is cancelled before
            # the wheel starts, so a scroll can never leave the button down.
            events.extend(self._release_pointer(now_ms, "Scroll started."))
            self.pinching = False
            self._pinch_since = None
            # The pose keeps the click path suppressed through its grace window
            # even before the wheel arms: the end of a scroll must never click.
            self.scrolling = True
            self._scroll_grace_until = now_ms + self.config.scroll_grace_ms
            # Only an *armed* wheel turns. A closed hand held still is a fist,
            # and the grab path below needs that frame.
            if self._scroll_armed:
                events.extend(self._update_scroll(scroll_pointer or pointer, now_ms))
            return events

        self._maybe_end_scroll(now_ms)
        if self.scrolling:
            # The scroll pose flickered out but is still inside its grace window.
            # Stay in the wheel stream: the index is still against the thumb, so
            # pressing here would click at the end of every scroll.
            return events

        if pinching:
            if not self.pinching:
                self.pinching = True
                self._pinch_since = now_ms
            elif (
                not self._pressed
                and self._pinch_since is not None
                and now_ms - self._pinch_since >= self.config.pinch_settle_ms
            ):
                self._pressed = True
                self._pressed_at = pointer
                self.click_count += 1
                events.append(
                    GestureEvent(
                        "pointer.press",
                        self.phase,
                        "Pressed.",
                        now_ms,
                        {"x": round(pointer[0], 4), "y": round(pointer[1], 4)},
                    )
                )
        else:
            events.extend(self._release_pointer(now_ms, "Pinch released."))
            self.pinching = False
            self._pinch_since = None

        return events

    def _arm_scroll(
        self,
        pose: bool,
        pointer: tuple[float, float] | None,
        now_ms: int,
    ) -> None:
        """Decide whether a closed-hand pose is a wheel or a fist.

        A real fist and the three-finger scroll curl the ring and pinky to
        almost the same values (live data: 0.56-0.67 for both), so no pose
        threshold can separate them — every grab was read as a scroll and the
        page turned instead of the window moving. Motion separates them: a fist
        held up to grab stays where it is for the 450 ms hold, while a wheel is
        a deliberate sweep. The wheel therefore stays off until the hand has
        travelled `scroll_arm_distance` since the pose formed. A pose that is
        held still re-bases its anchor instead of slowly drifting into a scroll.
        """
        if not pose or pointer is None:
            # Keep the armed state through the scroll grace window, so a one
            # frame dropout does not force the user to re-arm mid-sweep.
            if not self.scrolling:
                self._scroll_armed = False
                self._scroll_pose_since = None
                self._scroll_anchor_y = None
                self._scroll_move_ms = None
            return

        y = pointer[1]
        if self._scroll_armed:
            # Once armed, the wheel used to stay armed for as long as the pose
            # held — so a fist that travelled a little on the way up stayed a
            # wheel, the grab branch was skipped, and the status bar said
            # "Scroll" while the user was trying to grab a window.
            #
            # A real sweep keeps moving. A hand that has settled and is now
            # essentially still is a fist being held, not a wheel, so arming is
            # handed back once the hand stops travelling for `scroll_arm_ms`.
            # The accumulator is dropped with it: the wheel restarts from the
            # current position if the hand sweeps again.
            if self._scroll_anchor_y is None:
                self._scroll_anchor_y = y
                self._scroll_still_since = now_ms
                return
            if abs(y - self._scroll_anchor_y) >= self.config.scroll_arm_distance:
                self._scroll_anchor_y = y
                self._scroll_still_since = now_ms
                return
            if self._scroll_still_since is None:
                self._scroll_still_since = now_ms
                return
            if now_ms - self._scroll_still_since >= self.config.scroll_arm_ms:
                # Settled: back to being a fist, so the grab can run.
                self._scroll_armed = False
                self.scrolling = False
                self._scroll_anchor_y = None
                self._scroll_pose_since = None
                self._scroll_still_since = None
                self._scroll_accum = 0.0
                self._scroll_armed_ms = None
            return
        self._scroll_still_since = None
        if self._scroll_pose_since is None or self._scroll_anchor_y is None:
            self._scroll_pose_since = now_ms
            self._scroll_anchor_y = y
            self._scroll_move_ms = None
            return

        travel = abs(y - self._scroll_anchor_y)
        if travel < self.config.scroll_arm_distance:
            # Under the arming distance: the hand settled, so re-base once it has
            # been still for `scroll_arm_ms`. A fist that drifts up and back down
            # over a few frames never reaches the arming distance, so it stays a
            # fist and can grab.
            if now_ms - self._scroll_pose_since >= self.config.scroll_arm_ms:
                self._scroll_pose_since = now_ms
                self._scroll_anchor_y = y
            return


        # Travel big enough to arm. One frame is enough: a deliberate sweep is
        # fast, and requiring it to persist threw away real sweeps at the 5-10 fps
        # this machine drops to under load.
        self._scroll_armed = True
        self._scroll_armed_ms = now_ms
        self.scrolling = True

        # Hand the travel that armed the wheel to the accumulator instead of
        # throwing it away: at 5-10 fps it can be most of a notch.
        #
        # But only when that travel is a believable sweep. Bringing the hand into
        # position covers far more than the arming distance in a single frame, and
        # replaying *that* turned the page the moment the user cupped their hand —
        # the reported "cupping a fist in front scrolls instead of grabbing". An
        # arrival is a jump; a sweep is motion a hand can actually produce, and
        # `scroll_max_speed` already defines where that line sits.
        dt_ms = max(1, now_ms - self._scroll_pose_since)
        speed = travel / (dt_ms / 1000.0)
        believable = speed <= self.config.scroll_max_speed
        self._scroll_last_y = self._scroll_anchor_y if believable else y
        self._scroll_last_ms = self._scroll_pose_since if believable else now_ms
        self._scroll_accum = 0.0

    def _update_desktop_switch(
        self,
        left_fist: bool,
        pointer: tuple[float, float],
        now_ms: int,
    ) -> list[GestureEvent]:
        """A held left fist slides between virtual desktops.

        The intended feel, in the user's words: "as I move from right to left or
        vice versa with my left fist, it should slowly move the thing in that
        direction until it eventually reaches the next desktop similar to a
        trackpad 4 finger gesture. Not a sudden jerk in that direction to move
        across desktops."

        So this is a **continuous proportion**, not a step counter. One step is
        *not* one desktop: the hand must cover a full `desktop_step` of sideways
        travel before a desktop is committed, and a short nudge does nothing at
        all. Travel accumulates across frames, and it is only consumed when a
        desktop is actually committed — so moving slowly still gets there, and
        moving a little and stopping goes nowhere.

        `desk_progress` carries the partial travel, and it is reported so the UI
        can show the slide in progress. Any reversal immediately resets it, which
        is what makes the gesture feel like it is following the hand rather than
        tallying ticks.

        Windows cannot animate the desktop slide itself — Win+Ctrl+Arrow is the
        only public entry point and it snaps — so the *decision* is progressive
        even though the shell's final move is instant.
        """
        if not left_fist:
            # Released. Re-anchor, so the next fist is measured from where it is
            # formed rather than from the last place the previous one ended.
            self._desk_anchor_x = None
            self._desk_progress = 0.0
            return []

        x = pointer[0]

        if self._desk_anchor_x is None:
            self._desk_anchor_x = x
            self._desk_progress = 0.0
            return []

        step = max(self.config.desktop_step, 1e-6)

        # Direction change: start the slide over from *here*.
        #
        # The anchor is moved to the current position, so the new travel is
        # measured from the turn-around point. Leaving it behind made a reversed
        # hand keep accumulating against the old origin and commit a desktop in
        # the direction it had already abandoned.
        travel = x - self._desk_anchor_x

        # Compare with the progress already banked, which is where the hand got
        # to. Moving back toward the anchor is the reverse of that, even though
        # the travel from the anchor is still on the original side.
        if self._desk_progress and (travel < 0) != (self._desk_progress < 0):
            self._desk_anchor_x = x
            self._desk_progress = 0.0
            return []
        if self._desk_progress and abs(travel) < abs(self._desk_progress) * step:
            # Moved back toward the anchor: discard what was banked and start
            # again from here, so the slide always follows the hand.
            self._desk_anchor_x = x
            self._desk_progress = 0.0
            return []

        if now_ms < self._desk_cooldown_until:
            # Just committed. Follow the hand so the travel that continues during
            # the cooldown is not banked and dumped as a burst afterwards.
            self._desk_anchor_x = x
            self._desk_progress = 0.0
            return []

        self._desk_progress = travel / step

        # A desktop is committed only when the hand has covered a whole step.
        if abs(self._desk_progress) < 1.0:
            return []

        direction = 1 if self._desk_progress > 0 else -1
        # Consume exactly one desktop's worth and keep the remainder, so a long
        # sweep flows desktop to desktop without the remainder being lost.
        self._desk_anchor_x += direction * step
        self._desk_progress = 0.0
        self._desk_cooldown_until = now_ms + self.config.desktop_cooldown_ms
        self.desktop_count += 1
        return [self._desk_switch(direction, now_ms)]

    def _desk_switch(self, direction: int, now_ms: int) -> GestureEvent:
        """Build one desktop-switch event."""
        label = "right" if direction > 0 else "left"
        return GestureEvent(
            "desktop.switch",
            self.phase,
            f"Desktop {label}.",
            now_ms,
            {"direction": label},
        )

    def _update_scroll(self, pointer: tuple[float, float], now_ms: int) -> list[GestureEvent]:
        """Turn vertical hand travel into wheel notches, one stream per pinch.

        The first frame only records a baseline; movement from there is
        accumulated so slow motion still scrolls and a single frame never
        produces a burst.

        The page follows the hand, like dragging it: moving the hand up moves
        the content up, which in Windows is a *negative* wheel delta. The
        earlier mapping turned the wheel the other way and read as inverted.
        """
        y = pointer[1]

        if not self.scrolling or self._scroll_last_y is None or self._scroll_last_ms is None:
            self.scrolling = True
            self._scroll_last_y = y
            self._scroll_last_ms = now_ms
            self._scroll_accum = 0.0
            return []

        dt = (now_ms - self._scroll_last_ms) / 1000.0
        delta = y - self._scroll_last_y
        self._scroll_last_y = y
        self._scroll_last_ms = now_ms
        if dt <= 0:
            return []
        # A frame that moves faster than any hand can is a landmark jump, not a
        # scroll. Test the *speed*: a fixed distance per frame rejects ordinary
        # sweeps whenever the service is running slowly.
        if abs(delta) / dt > self.config.scroll_max_speed:
            return []

        self._scroll_accum += delta / max(self.config.scroll_step, 1e-6)

        # int() truncates toward zero, which is correct for both directions.
        notches = int(self._scroll_accum)
        if notches == 0:
            return []
        limit = max(1, self.config.scroll_max_notches_per_frame)
        if abs(notches) > limit:
            clamped = limit if notches > 0 else -limit
            # Keep the travel the cap did not send. Dropping it lost most of a
            # fast sweep, and the sweep is exactly when the user expects the page
            # to move.
            self._scroll_accum -= clamped
            notches = clamped
        else:
            self._scroll_accum -= notches
        self.scroll_count += 1
        return [
            GestureEvent(
                "pointer.scroll",
                self.phase,
                f"Scroll {notches + 0:+d}.",
                now_ms,
                {"notches": notches},
            )
        ]

    def _maybe_end_scroll(self, now_ms: int) -> None:
        """End the scroll stream only after a short grace period.

        The pose threshold sits where real hands hover, so a frame can drop out
        and come straight back. Ending on the first miss reset `_scroll_last_y`
        and the accumulator, so a continuous sweep never reached a full notch.
        """
        if not self.scrolling:
            return
        if now_ms < self._scroll_grace_until:
            return
        self._end_scroll()

    def _end_scroll(self) -> None:
        self.scrolling = False
        self._scroll_last_y = None
        self._scroll_last_ms = None
        self._scroll_accum = 0.0
        self._scroll_grace_until = 0
        self._scroll_armed = False
        self._scroll_pose_since = None
        self._scroll_anchor_y = None
        self._scroll_move_ms = None

    def _release_pointer(self, now_ms: int, message: str) -> list[GestureEvent]:
        """Emit a mouse-up if a pinch left the button down."""
        if not self._pressed:
            return []
        self._pressed = False
        at = self.pointer or self._last_pointer or self._pressed_at
        self._pressed_at = None
        detail: dict[str, object] = {}
        if at is not None:
            detail = {"x": round(at[0], 4), "y": round(at[1], 4)}
        return [GestureEvent("pointer.release", self.phase, message, now_ms, detail)]

    def release_pointer(self, now_ms: int, message: str = "Pointer released.") -> list[GestureEvent]:
        """Public safety release for callers that stop control mid-pinch."""
        events = self._release_pointer(now_ms, message)
        self.pinching = False
        self._pinch_since = None
        self._end_scroll()
        return events

    # -- dictation (cupped hand at the mouth) ------------------------------
    def _update_dictation(self, now_ms: int, distance: float, curl: float) -> list[GestureEvent]:
        events: list[GestureEvent] = []
        # Starting dictation cancels a pending grab hold, and vice versa, so the
        # user never gets both from one continuous movement.
        self._front_since = None

        if self._mouth_since is None:
            self._mouth_since = now_ms
            self.phase = Phase.APPROACHING
            events.append(
                GestureEvent(
                    "gesture.hold",
                    self.phase,
                    "Hand cupped at mouth — hold to activate dictation.",
                    now_ms,
                    {"distance": round(distance, 3), "curl": round(curl, 3), "hold_ms": self.config.hold_ms},
                )
            )
        elif self.phase is Phase.APPROACHING and now_ms - self._mouth_since >= self.config.hold_ms:
            self.phase = Phase.LISTENING
            self.fired_count += 1
            self._last_active = True
            events.append(
                GestureEvent(
                    "dictation.start",
                    self.phase,
                    "Dictation activated by gesture. (Listening is simulated.)",
                    now_ms,
                    {"distance": round(distance, 3), "curl": round(curl, 3)},
                )
            )
        return events

    # -- grab (fist held in front) -----------------------------------------
    def _update_grab(self, now_ms: int, distance: float, curl: float) -> list[GestureEvent]:
        events: list[GestureEvent] = []
        self._mouth_since = None

        if self._front_since is None:
            self._front_since = now_ms
            events.append(
                GestureEvent(
                    "grab.hold",
                    self.phase,
                    "Fist raised — hold to grab the active window.",
                    now_ms,
                    {"distance": round(distance, 3), "curl": round(curl, 3), "hold_ms": self.config.grab_hold_ms},
                )
            )
        elif self._grab_phase is None and now_ms - self._front_since >= self.config.grab_hold_ms:
            # The window is grabbed once per raise. Releasing the fist (or moving
            # it away) ends the grab; lowering it does not grab again.
            self._grab_phase = now_ms
            self.grab_count += 1
            events.append(
                GestureEvent(
                    "window.grab",
                    self.phase,
                    "Active window grabbed.",
                    now_ms,
                    {"distance": round(distance, 3), "curl": round(curl, 3)},
                )
            )
        return events

    # -- release -----------------------------------------------------------
    def _release(self, now_ms: int) -> list[GestureEvent]:
        events: list[GestureEvent] = []
        was_listening = self.phase is Phase.LISTENING

        if self._mouth_since is not None:
            held_ms = now_ms - self._mouth_since
            self._mouth_since = None
            if was_listening:
                self._cooldown_until = now_ms + self.config.cooldown_ms
                self.phase = Phase.COOLDOWN
                self._last_active = False
                events.append(
                    GestureEvent(
                        "dictation.stop",
                        self.phase,
                        "Hand lowered — dictation ended. (Simulated.)",
                        now_ms,
                        {"held_ms": held_ms},
                    )
                )
            elif held_ms < self.config.hold_ms:
                events.append(
                    GestureEvent(
                        "gesture.cancel",
                        self.phase,
                        "Released before the hold completed.",
                        now_ms,
                        {"held_ms": held_ms},
                    )
                )

        if self._front_since is not None:
            held_ms = now_ms - self._front_since
            grabbed = self._grab_phase is not None
            self._front_since = None
            self._grab_phase = None
            if grabbed:
                self._cooldown_until = now_ms + self.config.grab_cooldown_ms
                self.phase = Phase.COOLDOWN
                events.append(
                    GestureEvent(
                        "window.release",
                        self.phase,
                        "Active window released.",
                        now_ms,
                        {"held_ms": held_ms},
                    )
                )

        return events

    # -- throw -------------------------------------------------------------
    def throw(self, now_ms: int, direction: str, speed: float) -> list[GestureEvent]:
        """Record a throw, if the release was fast enough to count as one.

        Called by the service when a pinch is released. We require both a real
        direction and sufficient speed, so simply opening the fingers produces
        nothing.
        """
        if direction == "none" or speed < self.config.throw_min_speed:
            return []
        self.throw_count += 1
        return [
            GestureEvent(
                "window.throw",
                self.phase,
                f"Thrown {direction}.",
                now_ms,
                {"direction": direction, "speed": round(speed, 2)},
            )
        ]

    # -- helpers -----------------------------------------------------------
    def _active_hold(self) -> bool:
        return self._mouth_since is not None or self._front_since is not None

    def _clear_holds(self) -> None:
        self._mouth_since = None
        self._front_since = None
        self._grab_phase = None
        self._release_since = None

    # -- arming ------------------------------------------------------------
    def arm(self, now_ms: int) -> list[GestureEvent]:
        if self.armed:
            return []
        self.armed = True
        self.phase = Phase.ARMED
        return [GestureEvent("armed", self.phase, "Gesture control armed.", now_ms)]

    def disarm(self, now_ms: int) -> list[GestureEvent]:
        if not self.armed:
            return []
        self.armed = False
        # Read the grabbed state before clearing it, so we can report the release.
        was_grabbed = self._grab_phase is not None
        was_pressed = self._pressed
        self._clear_holds()
        self._end_scroll()
        self._lost_since = None
        was = self.phase
        self.phase = Phase.INACTIVE
        self._last_active = False
        events = [GestureEvent("disarmed", self.phase, "Gesture control disarmed.", now_ms)]
        if was_pressed:
            events.extend(self.release_pointer(now_ms, "Pointer released (disarmed)."))
        if was is Phase.LISTENING:
            events.append(GestureEvent("dictation.stop", self.phase, "Dictation ended (disarmed).", now_ms))
        if was_grabbed:
            events.append(
                GestureEvent(
                    "window.release",
                    self.phase,
                    "Window released (disarmed).",
                    now_ms,
                    {"cancelled": True},
                )
            )
        return events

    # -- introspection -----------------------------------------------------
    def snapshot(self) -> dict[str, object]:
        return {
            "phase": self.phase.value,
            "armed": self.armed,
            "fired": self.fired_count,
            "grabbed": self.grab_count,
            "clicked": self.click_count,
            "thrown": self.throw_count,
            "pinching": self.pinching,
            "pressed": self._pressed,
            "scrolling": self.scrolling,
            "scrolled": self.scroll_count,
            "pointer": None if self.pointer is None else [round(self.pointer[0], 4), round(self.pointer[1], 4)],
            "hold_ms": self.config.hold_ms,
            "grab_hold_ms": self.config.grab_hold_ms,
            "cooldown_ms": self.config.cooldown_ms,
        }
