import SwiftUI

/// A new thread's worktree as it is made, after Send (the web's `WorktreeCreationCard`): the
/// heading, a line per step reached (checkout with its percent, a finished step with its time),
/// why it stopped, the daemon's log behind More details, and Don't use worktree, Cancel, Retry
/// and Continue as the daemon offers them, and Back to New thread once it stopped. The thread
/// opens on its own once it exists.
struct WorktreeStartView: View {
    let card: WorktreeStartCard
    let act: (String) -> Void
    /// Back to New thread with the words, once the start stopped; nil while it can't.
    var back: (() -> Void)? = nil
    @State private var details: Bool?
    var body: some View {
        // A failed setup script's output is what the person needs: it opens with the card.
        let open = details ?? (card.failed && !card.details.isEmpty && card.actions.contains { $0.id == "continue" })
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                HStack(spacing: AceDesign.Space.related) {
                    AceIcon(card.failed ? .warningCircle : .gitFork, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline)
                        .foregroundStyle(card.failed ? AceTheme.Status.failed : AceTheme.Colours.subtleForeground)
                    Text(card.headline).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(card.steps, id: \.label) { step in WorktreeStepLine(step: step) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Steps")
                if !card.note.isEmpty { words(card.note, tone: AceTheme.Colours.mutedForeground) }
                if card.locked {
                    words("Clear the stale Git lock in ace on your computer, then Retry.", tone: AceTheme.Colours.mutedForeground)
                }
                if !card.refused.isEmpty { words(card.refused, tone: AceTheme.Status.failed) }
                Button { withAnimation { details = !open } } label: {
                    HStack(spacing: AceDesign.Space.tight) {
                        AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                            .rotationEffect(.degrees(open ? 90 : 0))
                        Text("More details")
                    }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceDesign.Size.tap)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                if open {
                    Text(verbatim: card.details.isEmpty ? "Nothing logged yet." : card.details.joined(separator: "\n"))
                        .monospaced()
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(AceDesign.Space.related)
                        .background(AceDesign.Surface.fill, in: AceShape.block)
                        .accessibilityLabel("Worktree details")
                }
                if !card.actions.isEmpty {
                    HStack(spacing: AceDesign.Space.related) {
                        ForEach(card.actions) { action in
                            Button(action.label) { act(action.id) }
                                .buttonStyle(.bordered)
                                .disabled(!card.sending.isEmpty)
                                .accessibilityIdentifier("worktree.\(action.id)")
                        }
                    }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                }
                if let back {
                    Button("Back to New thread", action: back)
                        .buttonStyle(.borderless)
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .frame(minHeight: AceDesign.Size.tap)
                        .accessibilityHint("Puts your message back in New thread and forgets this start")
                        .accessibilityIdentifier("worktree.back")
                }
            }
            .padding(AceDesign.Space.feedSide)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("worktree.card")
    }
    private func words(_ text: String, tone: Color) -> some View {
        Text(text).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).foregroundStyle(tone)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One step reached: in flight with a spinner (checkout with its percent), else how it ended and
/// how long it took.
private struct WorktreeStepLine: View {
    let step: WorktreeStartCard.Step
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            Group {
                switch step.state {
                case "running": ProgressView().controlSize(.mini)
                case "failed": AceIcon(.warningCircle, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline).foregroundStyle(AceTheme.Status.failed)
                case "stopped": AceIcon(.stopCircle, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                default: AceIcon(.checkCircle, size: AceDesign.Size.glyphMeta, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .frame(minWidth: AceDesign.Size.lead)
            Text(step.label).lineLimit(1)
                .foregroundStyle(step.state == "running" ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            Spacer(minLength: AceDesign.Space.related)
            if let percent = step.percent {
                ProgressView(value: Double(percent), total: 100).frame(maxWidth: 96)
                Text("\(percent)%").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
            } else if step.state != "running" {
                Text(Duration.milliseconds(Int(step.elapsedMs)).formatted(.units(allowed: [.minutes, .seconds], width: .narrow, fractionalPart: .show(length: 1))))
                    .monospacedDigit().aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        .frame(minHeight: AceDesign.Size.lead + AceDesign.Space.related * 2)
        .accessibilityElement(children: .combine)
    }
}
