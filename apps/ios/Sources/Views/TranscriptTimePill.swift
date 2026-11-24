import SwiftUI

/// What the time pill shows: whether the reader is scrolling, and when the row on top was
/// written. Only the pill reads it, so a scroll that changes it never re-evaluates the feed; it
/// writes only on a change, and the row on top is looked up again only when another row is there.
@MainActor @Observable final class TranscriptTimeMarker {
    private(set) var scrolling = false
    /// When the row on top was written, ms since 1970; nil when no row up to it has a time.
    private(set) var at: Double?
    /// The clock's reading as `at` was last set, ms since 1970.
    private(set) var now: Double = 0
    /// The row whose time `at` is.
    @ObservationIgnored private(set) var rowID: String?

    func scroll(_ on: Bool) {
        if scrolling != on { scrolling = on }
    }

    /// The row on top is now `rowID`, written at `at`.
    func top(_ rowID: String, at: Double?, now: Double) {
        self.rowID = rowID
        guard at != self.at else { return }
        self.at = at
        self.now = now
    }
}

/// A small glass capsule just under the header, saying when the row on top of the transcript
/// was written while the reader scrolls (`TranscriptTimeLabel`). It fades in as a scroll starts
/// and out a second after it rests; with Reduce Motion it shows and hides at once. It takes no
/// touches and floats over the rows, so it never moves them.
struct TranscriptTimePill: View {
    let marker: TranscriptTimeMarker
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale
    @State private var shown = false

    var body: some View {
        ZStack {
            if shown, let at = marker.at {
                Text(TranscriptTimeLabel.text(for: Date(timeIntervalSince1970: at / 1000),
                                              now: Date(timeIntervalSince1970: marker.now / 1000),
                                              calendar: calendar, locale: locale))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .monospacedDigit()
                    .lineLimit(1)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .padding(.horizontal, AceDesign.Space.row)
                    .padding(.vertical, AceDesign.Space.tight)
                    .floatingGlass(AceShape.capsule, interactive: false)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .default, value: shown)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: marker.scrolling) {
            if marker.scrolling { shown = true; return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            shown = false
        }
    }
}

extension ConversationFeed {
    /// The reader's scroll started or rested: the pill shows while it moves.
    func timePillPhase(_ phase: TranscriptScrollPhase) {
        let scrolling = phase == .tracking || phase == .interacting || phase == .decelerating
        if scrolling { markTopTime() }
        timeMarker.scroll(scrolling)
    }

    /// Finds the row on top of the screen and, when another row is there, its time. Proportional
    /// to the rows on screen; the window's order is searched only when the row on top changes.
    func markTopTime() {
        let window = shown
        guard let id = anchor.keeper.frames.topRow(inset: intent.metrics.topInset, containing: {
            TranscriptFeedRow.block($0, in: window) != nil
        }), id != timeMarker.rowID else { return }
        let order = window.screen.blockOrder
        let blockID = String(id.dropFirst("block:".count))
        let at = order.lastIndex(of: blockID).flatMap { index in
            TranscriptTimeLabel.time(at: index) { Self.writtenAt(order[$0], in: window) }
        }
        timeMarker.top(id, at: at, now: model.now())
    }

    /// When a block was written, ms since 1970: its event's time, else its first item's; 0 for none.
    static func writtenAt(_ blockID: String, in thread: ThreadModel) -> Double {
        guard let row = thread.screen.blocks[blockID]?.row else { return 0 }
        if let at = row.event?.at, at > 0 { return at }
        for item in row.items {
            if let at = thread.items[item]?.row.createdAt, at > 0 { return at }
        }
        return 0
    }
}
