import SwiftUI

/// The goal, opened from the pill: its objective in full, why it isn't met yet, how much it has
/// used, and Pause or Resume and Clear where ace changes this provider's goals. Words are the
/// bridge's (`GoalRow`).
struct GoalSheet: View {
    let goal: GoalRow
    let canOperate: Bool
    let change: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                    Text(goal.objective)
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("goal.objective")
                    if !goal.reason.isEmpty {
                        Text(goal.reason).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    if !goal.usage.isEmpty {
                        Text(goal.usage).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.subtleForeground).monospacedDigit()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.sm)
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { actions }
            .background(AceTheme.Colours.background)
            .navigationTitle(goal.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("goal.close")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    @ViewBuilder private var actions: some View {
        if canOperate, goal.canPause || goal.canResume || goal.canClear {
            HStack(spacing: AceTheme.Spacing.sm) {
                if goal.canPause { action("Pause goal", "pause", id: "goal.pause", primary: true) }
                if goal.canResume { action("Resume goal", "resume", id: "goal.resume", primary: true) }
                if goal.canClear { action("Clear goal", "clear", id: "goal.clear", primary: false) }
            }
            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.md)
        }
    }
    @ViewBuilder private func action(_ title: String, _ change: String, id: String, primary: Bool) -> some View {
        let button = Button {
            busy = true
            Task {
                if await self.change(change), change == "clear" { dismiss() }
                busy = false
            }
        } label: {
            Text(title).fontWeight(.medium).frame(maxWidth: .infinity)
                .foregroundStyle(primary ? AceTheme.Colours.onAccent : AceTheme.Colours.foreground)
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .disabled(busy)
        .accessibilityIdentifier(id)
        if primary {
            button.buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
        } else {
            button.buttonStyle(.bordered).tint(AceTheme.Colours.foreground)
        }
    }
}

/// The queued messages, opened from the pill: each can get new words, go now, move or be removed.
struct QueueSheet: View {
    let queue: QueueRow
    let canAct: Bool
    let canSteer: Bool
    let edit: (QueueRow.Message, [String: Any]) async -> Bool
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                QueueList(queue: queue, canAct: canAct, canSteer: canSteer, edit: edit)
                    .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.sm)
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Queued")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("queue.close")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
