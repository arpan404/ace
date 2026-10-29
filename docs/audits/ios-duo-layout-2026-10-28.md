# iOS Duo layout and composer interactions

The folded sidebar must push a rounded thread panel to the right, retain the native compact
icon menu for adding files and context, and keep the title and scope aligned. The + button sits
outside the message field on its left.

## Findings and changes

- Moving the entire navigation container during the drawer transition made Duo toolbar buttons
  switch between the vertical rail and horizontal placement. The original repeated-toggle UI
  test failed after its first close with an invalid toolbar hit target. Only the rendered thread
  content now moves and rounds; the navigation containers retain their window coordinates. The
  dimming layer follows the rounded card, leaving its corners clear.
- The nested drawer hosting view inherited a horizontal inset inappropriate to its narrower
  viewport. Removing the old workaround reproduced a row starting at x = -40 points. The
  replacement converts the navigation safe rectangle into the hosting view's coordinates,
  calculates the two horizontal edges separately, and restores only its own additional insets
  when it detaches. It contains no model, screen-size, or orientation checks.
- The title menu uses a plain button presentation so its own padding does not shift the title
  relative to the scope line.
- The attachment presenter remains outside the changing compact/expanded message field. A
  stable UIKit button presents the standard icon menu. Its actions are updated without replacing
  the menu while typing or changing focus. Photo, camera, file, folder, recall and catalog
  commands retain their existing behavior. Raw builtin labels such as `review` and `model` are
  displayed as “Review changes” and “Change model”.
- Delayed tab-bar placement work is cancelled when superseded or dismantled, and detached
  controllers do not change tab-bar visibility.

## Verification

On the folded iPhone Duo simulator, four focused UI tests passed:

- Three consecutive sidebar open/close cycles retain toolbar placement and tappability.
- Thread and search-command rows remain inside the visible drawer.
- The + stays outside the message field before and after focus, with a full touch target.
- Selecting Photo Library once from a focused composer opens the picker.

The two composer checks also passed on iPhone 18 Pro Max. Native drawer model checks passed
15 tests. The simulator build and repository formatting check passed. The existing full repository
check reproduced previously established Codex fixture and fake-daemon failures; it is not green.
No physical iPhone was updated.

## Apple guidance consulted

[Prepare your app for iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111461/)
recommends adaptive navigation, independently handled safe-area edges, and local view geometry.
[Raise the bar with iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111462/)
explains that vertical toolbar participation depends on a navigation container reaching the
appropriate display edge. Moving that container is therefore different from moving its content.
[Strike a pose with adaptive layouts](https://developer.apple.com/videos/play/tech-talks/111463/)
covers reserved regions and arrangements; arrangements do not replace navigation containers.

Apple's exported App Resizability skill was used for a read-only audit and independent review.
Launch-screen configuration, all four iPad orientations, and the absence of the full-screen
opt-out were checked. The scan found no main-screen sizing, orientation-based layout, or device
idiom layout branches in production iOS sources.

## Final polish verification

The compact drawer header has additional top spacing. Heading and scope share the same native
menu label inset. While the drawer covers the thread, its options button and shared glass
background are hidden together, removing the empty circle without moving the sidebar button.
The updated build passed another three open/close cycles on the folded Duo. The captured open
state shows the rounded shifted thread and no empty options circle. The native attachment
button owns its plus glyph and dismisses its context menu when the window changes size; repeated
menu dismissal and the first-selection photo-picker checks passed on Duo.

The unfolded Duo composer test also passed with the keyboard shown: the separate add button
remains left of the message field, meets the touch-target size, and opens the file/photo menu.
The corresponding full-screen attachment is black on this multi-display simulator; this is
accessibility/frame-test evidence, not a visual sign-off of the inner display.

## Follow-up: stale inset after resizing

The original incremental correction could retain a negative horizontal additional inset after
its inherited inset disappeared. UIKit clamps the effective safe area to zero, so comparing
that value to the desired zero cannot detect the leftover compensation. A focused UIKit
boundary test reproduced a retained −40-point left inset after a geometry change.

The probe now removes only its own previous correction, measures the inherited safe area
again, and applies a fresh correction when local geometry or window insets change. Unchanged
geometry does no work. Application and restoration guard against reentrant layout callbacks.

The new regression failed before the fix and passed afterwards. The complete native drawer
suite passed all 16 tests. Three Duo UI tests passed for repeated transitions, thread/search
row edges, and resize cycles with OCR checks of the visible heading and its distance from
the screen edge. A manual fold/unfold fixture check also passed, but rotation and folding
alone did not reliably reproduce the user's exact left-clipped screenshot. This patch fixes
the demonstrated stale-inset mechanism; it does not claim every reported Duo issue is solved.
Temporary geometry logging was removed. The existing full repository test failures documented
above remain outside this Swift-only follow-up.
