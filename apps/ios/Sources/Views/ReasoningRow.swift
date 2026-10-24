import SwiftUI

/// What the agent thought, as one quiet row: "Thinking…" while it thinks, "Thought for 12s" once
/// done (`@ace/ui-core` `thoughtLabel`, from the log's header or the row's own `thought`), the
/// same height either way so nothing moves when it finishes. The thought opens in place as muted
/// Markdown; the open row takes the fill, with no caret, as on the web.
struct ReasoningRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: TranscriptRow
    /// Its header as the log reads it; without one it reads the row's own header, else plainly.
    var thought: BlockRow.Thought? = nil
    var thread: ThreadModel? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var workEnded = false
    @State private var localOpen = false
    private var key: String { "step:\(row.id)" }
    private var open: Bool { thread.map { $0.disclosures.isOpen(key) } ?? localOpen }
    var body: some View {
        // A thought whose turn is over is finished, whatever its stream last said.
        let done = thought?.done ?? (row.complete || workEnded)
        let label = thought?.label ?? row.thought ?? (done ? "Thought" : "Thinking…")
        let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Button {
                if !open { DisclosureTrace.shared.asked("thought", key: key) }
                withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) {
                    if let thread { thread.disclosures.toggle(key) } else { localOpen.toggle() }
                }
            } label: {
                LogRowBox(open: open) { AceIcon(.brain, size: 16, relativeTo: .subheadline) } title: { Text(label).shimmer(!done) }
            }
            .buttonStyle(.plain)
            // Still thinking with no words yet: a header with nothing to open.
            .disabled(text.isEmpty)
            .accessibilityIdentifier("thought.\(row.id)")
            .accessibilityValue(text.isEmpty ? "" : open ? "Expanded" : "Collapsed")
            if open, !text.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    MarkdownView(text: text).foregroundStyle(AceTheme.Colours.mutedForeground)
                    if row.truncated, let openMessage {
                        Button("Read full thought") { openMessage(row) }
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .rowDetailIndent().padding(.bottom, AceTheme.Spacing.sm)
                .onAppear { DisclosureTrace.shared.shown(key) }
            }
        }
        .railMark(done ? .done : .running)
    }
}
