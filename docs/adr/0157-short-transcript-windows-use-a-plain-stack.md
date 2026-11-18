# 0157: Short transcript windows use a plain stack

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, choosing option 1 of
three in chat). Amends [ADR 0062](0062-long-thread-data-apis.md), "Phone client", decision
**List** (the feed stays a `LazyVStack`). Amended by
[ADR 0171](0171-the-keyboard-lifts-the-thread-foot-by-one-drawn-value.md).

## Context

On the iPhone, swiping fast the moment a long finished thread opens (`ios-log-long`, about 24
rows of 42 to 278 pt) pinned the main thread in about one run in three, swipes taking 66 to 175
s (#2051's follow-up). Removing any one feed piece (the chip flow, the default scroll anchors, the
geometry readers, the end-follow logic, Markit, the work-log rows) left it stalling, and the
real feed alone on a bare screen stalled too. A plain SwiftUI lazy stack with 150 similar rows
never did (0 of 12).

Logging every height in the stall showed the cause: no row, spacer or tail changed, but the
`LazyVStack`'s content height flipped between 2,250 and 2,251 pt (another run 2,252 and 2,253)
thousands of times. The stack's estimate for the rows it hasn't laid out swapped by a point on
alternate passes; the changing content size kept the scroll view decelerating, which made it
estimate again. The same bare feed in a `VStack`, which never estimates, passed 12 of 12 and its
content height settled in four steps at 2,895 pt. SwiftUI offers no way to give a lazy stack
fixed estimates.

A plain stack lays every row out, so it can't hold a long window: on `ios-stream` (201 rows) an
eager open took first rows 1,713 ms against 1,262 lazy, and warm opens 2.4 to 4.3 s against 0.7
to 0.8 s, failing the warm-open budget even at slack 4 (about 10 ms per extra row on this Mac).

## Options considered

- **Always a plain stack.** Certain, but a window holds up to 2,000 rows when reading far back;
  measured at 201 rows it already broke the gate.
- **Keep the lazy stack and report it to Apple.** No cost, but the stall stays for VoiceOver and
  UI automation until SwiftUI changes.
- **A plain stack for short windows, the lazy one past a limit (chosen).** The windows that hit
  the loop are the short ones, where a few uneven rows move the estimate; long windows keep
  their bounded cost.

## Decision

1. **A window of at most `TranscriptStackChoice.defaultLimit` rows (48) is held in a `VStack`;
   longer, in the `LazyVStack`.** 48 is twice the window that stalled and well under the 201
   rows whose eager open failed the gate; it was picked from those two measurements, not a sweep.
2. **The stack is chosen before the rows first lay out, and switched rarely.** An eager stack
   turns lazy once its rows pass the limit; a lazy one turns eager only when its window is
   replaced (a jump, Scroll to end, a reconnect) by one at or under three quarters of the limit
   (36). Between the marks nothing switches.
3. **Never mid-scroll.** A switch waits until no gesture or animated scroll is running; a
   replacement seen while moving is kept for the next still moment.
4. **A switch keeps the reader's place.** It rebuilds every row, so the feed installs its top row
   as a session anchor, which the session restore puts back once the rebuilt rows measure; a feed
   following the live end scrolls to it again.

ADR 0062's window bounds and paging stay as they are.

## Consequences

- Short threads, the common case on the phone, no longer depend on the lazy stack's estimates.
- A switch costs one full layout of the window; the hysteresis keeps it to about one per window.
- Not verified: whether a long window (lazy, above the limit) can still hit the loop. The
  windows that stalled were short; a long one has many measured rows, so a one-row change moves
  the estimate far less, but that is untested (#2124).
- The limit came from two measurements; a measured reason can move it.

## Tests

- `AceTests/TranscriptStackChoiceTests`: the choice at first layout, growth past the limit only
  while still, no switch back without a replacement under the low mark, waiting out a scroll, and
  rows hovering around the limit switching at most once.
- `AceUITests/TranscriptAccessibilityUITests/testSwipingTheMomentALongFinishedThreadOpensStaysResponsive`
  and `ThreadUITests/testASwipeAlongTheTranscriptsTrailingEdgeScrollsIt` (no longer an
  expected failure) swipe `ios-log-long` the moment it opens.
