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
- **One value, set every frame, drawing both the composer and the rows (chosen).** The gap can't
  change because both are drawn from the same number in the same frame. Only how closely the
  composer keeps to the keyboard depends on a fitted curve.

## Decision

1. **The thread owns one `KeyboardRide`, and the keyboard's notification moves it.** Its `lift`
   is set on every frame by a display link from the frame's time since the notification and
   `KeyboardCurve`. Only a keyboard that reaches the foot lifts it
   (`TranscriptKeyboardLift.docked`), so a floating keyboard moves nothing.
2. **The composer is drawn by it and takes no system keyboard avoidance.** `FloatingBar` lays the
   bar out at the foot of the keyboard-free area and offsets it up by `lift`. The offset moves its
   taps with it; nothing is resized and no inset changes.
3. **Rows following the end are drawn by the same lift, then the scroll takes over.** While the
   ride runs they're offset up by `lift` beyond the lift the scroll already allows for
   (`KeyboardRideOffset`), outside the rows' coordinate space and inside the content reader, so
   row measurements and the place keeper never see it. When it lands, one transaction sets the
   offset to 0 and scrolls to the end, a frame that moves nothing.
4. **The room changes at once, and a closing keyboard's room stays below the end until it lands**
   (`TranscriptKeyboardRoom`). The content never shrinks under an offset that's still moving.
   The only part of the feed the offset brings into view is that empty room.
5. **`KeyboardCurve` is the keyboard as drawn, erring above it:** an ease-out at a rate of 5.94
   over the notified duration, fitted to traced moves. Where the fit is off, the composer should
   show floor above the keyboard rather than slip under it, so an opening ride starts 12 ms after
   the notification and a closing one 30 ms after.

Rows that aren't following the end don't ride, as before. Reduce Motion moves everything at once.

## Consequences

- The composer and the newest line keep their gap on every frame of an opening and a closing.
- Measured on the iPhone 17 Pro simulator (iOS 26.1), the gap between the newest line and the
  composer moved by 0 pt on every frame of an opening and a closing (it was 44 and 276 pt).
- The composer no longer sits exactly on the system's keyboard edge: opening, it runs up to
  56 pt ahead, with the page-coloured floor under the bar showing between them, and dips under
  the edge by up to 7 pt; closing, it stays within 13 pt. A machine under heavy load moved
  these by about 20 pt more.
- The curve came from one simulator and OS. A new iOS that changes the keyboard's motion shows up
  as the composer straying from the keyboard, and the probe's `lag` measures it.
- A display link runs for the length of each keyboard move, about half a second, and redraws two
  offset modifiers per frame.

## Tests

- `AceUITests/TranscriptEndUITests/testTheNewestLineAndTheComposerMoveAsOneWithTheKeyboard` reads
  the probe's gaps over an opening and a closing and holds their spread to 4 pt.
- `AceTests/KeyboardCurveTests` holds the curve to a traced keyboard move.
- `AceTests/TranscriptViewportSessionTests`: the docked lift and the room that stays below the end.
- `TranscriptEndUITests`' keyboard checks and `ComposerSuggestionsUITests` keep the end, Scroll to
  end and the pills working with the keyboard up.
