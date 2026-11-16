# 0171: The keyboard lifts the thread's foot by one drawn value

Status: proposed. Date: 2026-11-16. Decided by: the iOS keyboard drift rework (#2170), for the
owner to accept. Amends [ADR 0157](0157-short-transcript-windows-use-a-plain-stack.md)'s area: it
leaves the stack choice alone and fixes how the transcript's end moves while the keyboard does.

## Context

On the iPhone the composer floats over the transcript. Before this change it moved with the
system's keyboard avoidance, while the transcript made room with a spacer under its last row
that changed height at once, then scrolled to its end on `spring(duration:, bounce: 0)`. A
fixture-only probe (`KeyboardDriftProbe`, `--perf-probe`) read the drawn position of the last
line, the composer and the keyboard's edge on every frame. On the iPhone 17 Pro simulator
(iOS 26.1, `ios-log-long`), the gap between the line and the composer swung by 44 pt as the
keyboard opened and 276 pt as it closed: closing shrank the spacer under a still offset, so the
line dropped behind the keyboard and scrolled back.

The two approaches #2166 tried (the foot as `safeAreaBar`, or the keyboard as the transcript's
bottom inset) broke taps on the pills and Scroll to end, and every inset change made the lazy
transcript re-estimate its height by about 126,000 pt and lose the end.

## Options considered

- **The same animation for the scroll and the composer.** Traced, a `withAnimation` around
  `scrollTo` runs on the scroll view's own curve whatever the transaction says: 37 and 91 pt.
- **A drawn offset on the rows, animated by SwiftUI on a curve fitted to the keyboard.** The
  curves matched, but a SwiftUI animation starts when its change commits, a frame or more after
  the keyboard starts, and how much later varies: 56 to 130 pt.
- **One value, set every frame from a fitted curve, drawing both the composer and the rows.**
  The gap held at 0 pt, but the composer ran up to 56 pt ahead of the keyboard on every
  opening, and the curve was fitted to one iOS version.
- **One value, set every frame from where the keyboard is drawn (chosen).** The gap still can't
  change, and the composer follows the keyboard's own animation, whatever curve a future iOS
  gives it.

## Decision

1. **The thread owns one `KeyboardRide`, and the keyboard's notification moves it.** Its `lift`
   is set on every frame by a display link. Only a keyboard that reaches the foot lifts it
   (`TranscriptKeyboardLift.docked`), so a floating keyboard moves nothing.
2. **The lift is read from where the keyboard is drawn.** `KeyboardEdgeTracker` pins a one-point
   view to the `keyboardLayoutGuide` of a container constrained to the window, so UIKit animates
   it with the keyboard on the keyboard's own animation (public API: a view constrained to the
   guide moves with the keyboard). Each tick evaluates that animation (its `CABasicAnimation` or
   `CASpringAnimation` parameters and timing function, `AnimationTiming`) at the time the lift
   reaches the screen, one frame after the frame the tick is for: the presentation layer says
   where the edge is now, and a lift set from it trailed the keyboard by exactly a frame. An
   animation UIKit has added but not committed has no begin time, so the tick commits it
   (`CATransaction.flush()`) before reading. The edge is read in the container's own points: SwiftUI
   places the representable's host with a transform the window constraints don't see, which
   added 116 pt when converted.
3. **Fallbacks.** If the animation can't be read, the presentation layer; if no edge moves yet,
   the fitted ease-out (`KeyboardCurve`, starting 12 ms after the notification when opening and
   30 ms when closing, so it errs above the keyboard). In the measured runs every frame was read
   from the animation, and the curve was used on no frame.
4. **The composer is drawn by it and takes no system keyboard avoidance.** `FloatingBar` lays the
   bar out at the foot of the keyboard-free area and offsets it up by `lift`. The offset moves its
   taps with it; nothing is resized and no inset changes.
5. **Rows following the end are drawn by the same lift, then the scroll takes over.** While the
   ride runs they're offset up by `lift` beyond the lift the scroll already allows for
   (`KeyboardRideOffset`), outside the rows' coordinate space and inside the content reader, so
   row measurements and the place keeper never see it. When it lands, one transaction sets the
   offset to 0 and scrolls to the end, a frame that moves nothing.
6. **The room changes at once, and a closing keyboard's room stays below the end until it lands**
   (`TranscriptKeyboardRoom`). The content never shrinks under an offset that's still moving.
   The only part of the feed the offset brings into view is that empty room.

Rows that aren't following the end don't ride, as before. Reduce Motion moves everything at once.

## Consequences

- Measured on the iPhone 17 Pro simulator (iOS 26.1), the gap between the newest line and the
  composer moved by 0 pt on every frame of an opening and a closing (it was 44 and 276 pt).
- From the third frame of a move on, the composer's foot is within 2 pt of the keyboard's edge,
  opening and closing. The first one or two moving frames, while the keyboard's animation is
  being committed, were off by 4 to 16 pt in runs on their own and up to 35 pt opening and 30 pt
  closing in a full suite run. That is short of the 2 pt aimed for; the likely cause, not yet
  measured, is the first frame's commit, when the feed takes on the ride.
- The tick commits the pending Core Animation transaction once per move, when it finds the
  keyboard's animation uncommitted.
- A display link runs for the length of each keyboard move, about half a second, and redraws two
  offset modifiers per frame.
- If a future UIKit stops animating views constrained to the keyboard layout guide, the ride
  falls back to the fitted curve, and the probe's per-source counts show it.

## Tests

- `AceUITests/TranscriptEndUITests/testTheNewestLineAndTheComposerMoveAsOneWithTheKeyboard` reads
  the probe over an opening and a closing: the gap's spread is at most 4 pt, every frame read the
  keyboard's edge, and the composer is within 2 pt of it from the third frame of a move on (40 pt
  for the first two).
- `AceTests/AnimationTimingTests` reads Bézier and spring timings; `AceTests/KeyboardCurveTests`
  holds the fallback curve to traced keyboard moves.
- `AceTests/TranscriptViewportSessionTests`: the docked lift and the room that stays below the end.
- `TranscriptEndUITests`' keyboard checks and `ComposerSuggestionsUITests` keep the end, Scroll to
  end and the pills working with the keyboard up.
