import SwiftUI

/// Rows that re-measured shorter than their estimates (a thread opened at its end, folds
/// closing) shrink the content under a still offset, leaving the feed past its end: an empty
/// screen until a drag bounces it back. Only a feed nobody is moving is put back.
enum TranscriptEnd {
    /// `toEnd`: how far the reachable end is below the bottom edge, negative past it.
    static func stranded(oldHeight: Double, newHeight: Double, toEnd: Double, moving: Bool) -> Bool {
        !moving && newHeight < oldHeight && toEnd < -1
    }
}

/// Gesture intent is consumed once per page; layout changes and programmatic scrolls never page.
/// Follow mode and scroll direction live in the viewport controller; intent
/// tracks only the in-flight gesture and paging consumption.
final class TranscriptScrollIntent {
    var active = false
    var consumed = false
    /// The person opened something in place: the next change of height is theirs, not the end's.
    var opened = false
    var metrics = Metrics(y: 0, top: 0, bottom: 0, viewport: 0, topInset: 0, bottomInset: 0, height: 0)
    struct Metrics: Equatable {
        let y: CGFloat; let top: CGFloat; let bottom: CGFloat; let viewport: CGFloat; let topInset: CGFloat; let bottomInset: CGFloat; let height: CGFloat
        /// How far the end the feed can reach is below the bottom edge: negative only when the
        /// feed sits past it. A feed shorter than the screen starts at its top, which is its end.
        var toEnd: CGFloat { max(height + bottomInset - viewport, -topInset) - y }
        static func strandedPastEnd(old: Metrics, new: Metrics, moving: Bool) -> Bool {
            TranscriptEnd.stranded(oldHeight: Double(old.height), newHeight: Double(new.height), toEnd: Double(new.toEnd), moving: moving)
        }
    }
    /// The feed's own animated scroll is still moving.
    var animating = false
    /// An older page was asked for and hasn't joined yet: its rows are held still as they land.
    var olderPage = false
    func begin() { active = true; consumed = false }
}

/// While the keyboard is up, a tap on the conversation only puts it away: the tap takes priority
/// over the rows' own (a tool group, a step, a link), so it never opens what lay under the finger.
/// Scrolling still dismisses it interactively. With the keyboard down the gesture is off and taps,
/// links, selection and menus reach the rows as usual.
struct TapPutsKeyboardAway: ViewModifier {
    let up: Bool
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .highPriorityGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }, including: up ? .all : .subviews)
    }
}

/// A height correction invalidates the affected spacer independently of the row list.
struct TranscriptSpacer: View {
    let extent: TranscriptExtent
    let height: KeyPath<TranscriptExtent, Double>

    var body: some View {
        let value = extent[keyPath: height]
        Color.clear.frame(height: value).accessibilityHidden(true)
            .onChange(of: value) { _, _ in PerfCounters.bump("extent.spacers") }
    }
}

/// The header over the transcript: on iOS 26 and later the bar draws nothing of its own and the
/// thread's header bar sets the system's scroll-edge effect (`ThreadHeaderBar`). Before, the bar is
/// opaque in the page colour.
struct TranscriptTopEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.toolbarBackground(AceTheme.Colours.background, for: .navigationBar)
                .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        }
    }
}

/// The previous and next turn on a hardware keyboard, listed in the ⌘ overlay by name.
struct TurnKeys: View {
    let step: (Int) -> Void
    var body: some View {
        VStack {
            // The web's keys by default; Settings › Keyboard can move them.
            Button("Previous turn") { step(-1) }.phoneShortcut("previousTurn")
            Button("Next turn") { step(1) }.phoneShortcut("nextTurn")
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
