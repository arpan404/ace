import SwiftUI

extension EnvironmentValues {
    /// Reads an item's whole text from its source (`native.message`), for answers and thoughts
    /// longer than a row carries. Nil where nothing can read it.
    @Entry var readMessage: (@MainActor (String) async throws -> String)? = nil
}

/// Agent prose as the web draws it: bare full-width Markdown, a pulsing caret while it streams,
/// and, once finished, its time and Copy under it. An answer longer than its row reads its whole
/// text on its own, saying so while it loads ("Loading full answer…", Try again on failure).
/// What the agent says between its steps (`between`) is plain prose: no time or actions.
struct AnswerRow: View {
    let row: TranscriptRow
    var streaming = false
    var between = false
    var openMessage: ((TranscriptRow) -> Void)? = nil
    @Environment(\.readMessage) private var readMessage
    @Environment(\.fileLinks) private var fileLinks
    @State private var full: String?
    @State private var problem: String?
    /// Whole answers past this many characters open in the reader instead of the row.
    private static let inline = 200_000
    var body: some View {
        // Text left incomplete by a turn that stopped no longer streams.
        let live = streaming && !row.complete
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            if !shown.isEmpty {
                let menu = !between && !live
                MarkdownView(text: shown, selectable: !menu).fileLinks(fileLinks, itemId: row.id)
                    .messageMenu(menu ? shown : "", title: "Answer")
            }
            if live { StreamingCaret() }
            if row.truncated && !live && full == nil { partial }
            if !between && (row.complete || (row.truncated && !live)) {
                MessageActions(at: row.createdAt, copy: shown, label: full == nil && row.truncated ? "Copy preview" : "Copy answer")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("message.answer.\(row.id)")
        .task(id: row.truncated && row.complete) { await load() }
    }
    private var shown: String { full ?? row.text }
    @ViewBuilder private var partial: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if let problem {
                Text(problem)
                HStack(spacing: AceTheme.Spacing.md) {
                    if readMessage != nil { Button("Try again") { Task { await load() } } }
                    if let openMessage { Button("Read full message") { openMessage(row) } }
                }
                .fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
            } else if readMessage != nil {
                Text("Loading full answer…").accessibilityAddTraits(.updatesFrequently)
            } else if let openMessage {
                Button("Read full message") { openMessage(row) }
                    .accessibilityIdentifier("message.full.\(row.id)")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
    private func load() async {
        guard row.truncated, row.complete, full == nil, let readMessage else { return }
        problem = nil
        do {
            let text = try await readMessage(row.id)
            if text.count > Self.inline { problem = "This answer is too long to show here." } else { full = text }
        } catch {
            if !Task.isCancelled { problem = error.localizedDescription }
        }
    }
}

/// The caret after text still arriving: a soft pulse, still under Reduce Motion. The pulse runs
/// in Core Animation, off the main thread: a SwiftUI repeating animation would redraw the view
/// graph on every frame for as long as an answer streams.
struct StreamingCaret: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        PulsingCapsule(colour: UIColor(AceTheme.Colours.mutedForeground), pulses: !reduceMotion)
            .frame(width: 3, height: AceTheme.Typography.body.size)
            .accessibilityElement()
            .accessibilityLabel("Streaming")
    }
}

/// A filled capsule whose opacity eases between 1 and 0.3 every 0.8 s, autoreversing.
private struct PulsingCapsule: UIViewRepresentable {
    let colour: UIColor
    let pulses: Bool
    func makeUIView(context: Context) -> PulseView { PulseView() }
    func updateUIView(_ view: PulseView, context: Context) {
        view.backgroundColor = colour
        view.pulses = pulses
    }

    final class PulseView: UIView {
        var pulses = false { didSet { if pulses != oldValue { restart() } } }
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            layer.cornerCurve = .continuous
        }
        required init?(coder: NSCoder) { nil }
        override func layoutSubviews() {
            super.layoutSubviews()
            layer.cornerRadius = min(bounds.width, bounds.height) / 2
        }
        // A layer leaving the window loses its animations; a row scrolled back in pulses again.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            restart()
        }
        private func restart() {
            layer.removeAnimation(forKey: "pulse")
            guard pulses, window != nil else { return }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.3
            pulse.duration = 0.8
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            layer.add(pulse, forKey: "pulse")
        }
    }
}
