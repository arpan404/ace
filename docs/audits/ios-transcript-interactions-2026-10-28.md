# iOS transcript and composer interaction audit

The supplied 12.8-second recording shows the transcript jumping between earlier messages and blank areas during scrolling. It does not show the separate photo-picker interaction reported in the accompanying message.

## Findings and changes

- History pages were applied as soon as the bridge emitted `reading.settled`, including during dragging and deceleration. Applying those pages invokes the transcript's scroll-anchor restoration. The native model now keeps presentation updates buffered until both the page has settled and the gesture has ended. This changes presentation timing; the SDK's live subscription and history window remain active.
- The history-loading marker was a row above the messages. Showing and hiding it changed the lazy stack's height while scrolling. It now overlays the feed without changing its layout or intercepting touches.
- Tail-update and composer-height callbacks could issue programmatic scrolling during a gesture. These callbacks now leave active user scrolling alone. Explicit Send and Scroll to end retain their existing actions.
- The attachment presenter occupied two conditional branches of the composer. Focus changes could destroy its photo/file/camera presentation state as the composer changed layout. One persistent overlay now hosts the attachment menu, with layout space reserved in each row.

## Verification

On the iPhone 18 Pro Max iOS 27 simulator:

- All ten `ClientModelTests` pass, including delivery of a settled page during a gesture and a gesture ending before the page settles. Neither condition alone exposes a partial page.
- `TranscriptEndUITests.testReadingOlderMessagesStaysVisibleAndStillWhileTheTailStreams` passes: eight fast upward swipes, a nonempty viewport, and stable visible message position while the fixture continues streaming.
- `MediaViewerUITests.testThePhotoPickerOpensOnTheFirstSelectionFromAFocusedComposer` passes: focus the composer, select Photo Library once, and observe the system picker.
- The existing UI cases for Scroll to end after reading and live following through tool bursts both pass.
- Simulator and signed physical-device builds, repository formatting and `git diff --check` pass. The final simulator build is installed on the Duo.

The earlier full repository check is red: 30 test files failed, 3,153 passed and 104 were skipped. That result is not a green validation of this audit. The simulator tests above are narrower evidence, and do not establish that every source of flicker has been eliminated. The original conversation on the physical phone still needs verification; the phone was unavailable to Xcode when installation was attempted.
