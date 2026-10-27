import SwiftUI

/// What holds the thread's queue, in the composer's one strip (DESIGN.md §8): one sentence and its
/// ways on as words, worded by the bridge (`bridge/queue-hold.ts`). "Codex is out of usage until
/// 1:14 AM · Switch · Resume at reset · Continue"; "Agent stopped · Continue"; "Queue paused ·
/// Resume". Switch opens the model sheet; Review opens the queue. The way on that carries the turn
/// on reads a step stronger. When the words and buttons don't fit one line, the buttons go under.
struct QueueHoldStrip: View {
    let strip: QueueRow.Strip
    let act: (QueueRow.Action) async -> Bool
    let chooseModel: () -> Void
    let openQueue: () -> Void
    @State private var acting = false
    var body: some View {
        StripSurface {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AceTheme.Spacing.sm) { words; Spacer(minLength: AceTheme.Spacing.none); buttons }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    words
                    HStack(spacing: AceTheme.Spacing.xs) { Spacer(minLength: AceTheme.Spacing.none); buttons }
                }
            }
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.hold")
    }
    private var words: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(strip.sentence)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("hold.sentence")
            if !strip.detail.isEmpty {
                Text(strip.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var buttons: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(strip.actions) { action in
                Button(action.label) { run(action) }
                    .buttonStyle(StripTextButtonStyle(prominent: action.primary == true))
                    .disabled(acting && action.id != "choose_model" && action.id != "queue")
                    .accessibilityIdentifier("hold.\(action.id)")
            }
        }
        .fixedSize()
    }
    private func run(_ action: QueueRow.Action) {
        switch action.id {
        case "choose_model": chooseModel()
        case "queue": openQueue()
        default:
            acting = true
            Task { _ = await act(action); acting = false }
        }
    }
}
