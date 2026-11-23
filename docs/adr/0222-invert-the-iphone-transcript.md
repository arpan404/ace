# 0222: Invert the iPhone transcript

Status: proposed. Date: 2026-11-23. Amends [ADR 0157](0157-short-transcript-windows-use-a-plain-stack.md),
specifically the placement of older pages.

## Context

In the iOS simulator at `8a664171ac`, equal upward flings in `ios-reading` moved
43, 43, 3, 19, 3, and 3 steps. The short flings hit page boundaries. The chronological
stack ran out of content, held the page until the scroll stopped, then restored the offset
after inserting older rows above it.

## Options considered

- Estimate the whole conversation in chronological layout. Every rehydrated page above the
  reader must match its reserved height or change the reader's offset.
- Invert a collection view. This gives direct control of estimated heights and cell reuse,
  but moves scrolling, keyboard handling and row hosting to UIKit.
- Invert the existing SwiftUI feed. Older rows extend the far edge and existing rows keep
  their coordinates. The stack can still choose eager or lazy based on the open window.

## Decision

1. **Lay out the live end first.** Flip the scroll view and flip each row back. Convert
   viewport measurements and scroll targets at the feed boundary so the anchor controller
   still speaks in chronological screen coordinates. Use chronological accessibility priority
   for message rows. Clip the flipped scroll view inside the safe-area viewport and hide its
   vertical scroll-edge effect. The navigation bar paints its own background.
2. **Allow proven older appends during motion.** Wait for the page fence and the read reply.
   Keep the rows in the viewport, half a screen ahead, and toward the live edge in order,
   with unchanged content. Further ahead, a page can complete and regroup a partial turn.
   Recycle newer rows during a fling only when their measured space can stay in the newer spacer. Hold replacements
   and uncertain pages until idle, then use the existing anchor correction.
3. **Keep the physical scroll offset during an append.** No snapshot, proxy scroll or
   explicit offset change is required for the append. Explicit anchor correction cannot
   set the offset during tracking, dragging, or deceleration. Use the scroll view's offset
   report as the sole source of the viewport origin.

## Tests

The scroll-axis tests check page growth at a fixed native offset and chronological row
geometry. The simulator paging and jump probes check the actual drawn feed and fling.
