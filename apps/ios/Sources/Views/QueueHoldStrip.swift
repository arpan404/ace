import SwiftUI

/// What holds the thread's queue, in the composer's one strip (DESIGN.md §8): one sentence and its
/// ways on as words, worded by the bridge (`bridge/queue-hold.ts`). "Codex is out of usage until
/// 1:14 AM · Switch · Resume at reset · Continue"; "Agent stopped · Continue"; "Queue paused ·
/// Resume". Switch opens the model sheet; Review opens the queue. The way on that carries the turn
/// on reads a step stronger. When the words and buttons don't fit one line, the buttons go under.
struct QueueHoldStrip: View {
    let strip: QueueRow.Strip
    /// False on a phone that can only view the machine: the sentence shows, the ways on are off.
    var canAct = true
    let act: (QueueRow.Action) async -> Bool
    let chooseModel: () -> Void
    let openQueue: () -> Void
    @State private var acting = false
    /// Bumped when a way on was taken: a light confirmation under the finger.
    @State private var taken = 0
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
        .sensoryFeedback(.success, trigger: taken)
    }
    private var words: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(strip.sentence)
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.numericText())
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
                    .disabled(!canAct || (acting && action.id != "choose_model" && action.id != "queue"))
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
            Task {
                if await act(action) { taken += 1 }
                acting = false
            }
        }
    }
}

/// Whether the hold strip shows and whether its ways on can be taken. It always shows while
/// something holds the turn: the pill leaves the limit's words to it, so a phone that can only
/// view the machine (or an archived thread) still reads why the turn waits, with the ways on
/// disabled.
struct HoldStripState: Equatable {
    let visible: Bool
    let actionable: Bool
    static func of(strip: QueueRow.Strip?, canOperate: Bool, archived: Bool) -> HoldStripState {
        HoldStripState(visible: strip != nil, actionable: strip != nil && canOperate && !archived)
    }
}
