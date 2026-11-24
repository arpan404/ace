# 0222: Invert the iPhone transcript

Status: proposed. Date: 2026-11-23. Amended 2026-11-23 (a flipped collection view). Amends [ADR 0157](0157-short-transcript-windows-use-a-plain-stack.md),
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

## Amendment: a flipped collection view (2026-11-23)

The inverted SwiftUI feed still moved the reader when an older page joined. In the simulator a
page of 12,234 pt landed mid-fling and the offset went from 911 to -814 in 47 ms with no offset
write from ace: the `ScrollView` and its lazy stack re-placed the content on their own. Its
offset adjustments can't be observed or turned off per change, so the transcript moves to UIKit,
the second option above.

1. **A flipped `UICollectionView` holds the rows.** Each cell hosts the existing SwiftUI row in
   a `UIHostingConfiguration`, flipped back upright. Entry 0 is the live end. The tail, the
   spacers, pending sends and the cached-history line are entries too.
2. **A custom layout owns every implicit offset change** (`TranscriptCollectionLayout`, from the
   pure `TranscriptStackGeometry`). Heights are measured per id and kept across window changes,
   and a row never measured starts at the mean of those that were. A height correction moves the
   offset only when the entry starts above the viewport's physical top. A window change keeps
   the reader's entry where it was on screen: an older page extends the far edge and moves
   nothing. UIKit keeps decelerating from an adjusted offset.
3. **A row is configured only when it comes on screen or its own key changes** (its block, room,
   links, stale state). A fling doesn't re-evaluate rows already drawn.
4. **UIKit reports the scroll.** Phases come from the scroll view's delegate. The release
   velocity comes from `scrollViewWillEndDragging(_:withVelocity:targetContentOffset:)`, so a
   device trace (`-ace-fling-trace`) records it. Row frames come from the layout.
5. **VoiceOver reads the cells on screen oldest first.** Three-finger swipes page in the
   direction they read. The feed keeps the `transcript` identifier; UI tests find it as a
   collection view.

The eager or lazy stack choice (ADR 0157) no longer applies to this feed: the collection view
only builds cells near the viewport.
