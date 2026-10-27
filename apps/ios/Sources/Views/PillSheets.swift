import SwiftUI

/// The goal, opened from the pill: its objective in full, why it isn't met yet, how much it has
/// used, and Pause or Resume and Clear where ace changes this provider's goals. Words are the
/// bridge's (`GoalRow`). A change stays pending ("Pausing…") until the daemon takes it, and a
/// refusal is said here, with the controls back. Clear asks first. Once taken, the bridge's next
/// goal redraws the sheet; a cleared goal closes it.
struct GoalSheet: View {
    let goal: GoalRow
    let canOperate: Bool
    /// Sends a change; resolves with nil once the daemon took it, else the refusal's words.
    let change: (String) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var pending: String?
    @State private var problem: String?
    @State private var confirmingClear = false
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
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("goal.close")
                }
            }
            .alert("Clear this goal?", isPresented: $confirmingClear) {
                Button("Cancel", role: .cancel) {}
                Button("Clear goal", role: .destructive) { send("clear") }.accessibilityIdentifier("goal.confirmClear")
            } message: {
                Text("“\(goal.objective)” stops guiding the agent. Set it again with /goal.")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    @ViewBuilder private var actions: some View {
        if canOperate, goal.canPause || goal.canResume || goal.canClear {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                if let problem {
                    Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                        .accessibilityIdentifier("goal.problem")
                }
                HStack(spacing: AceTheme.Spacing.sm) {
                    if goal.canPause { action(pending == "pause" ? "Pausing…" : "Pause goal", id: "goal.pause", primary: true) { send("pause") } }
                    if goal.canResume { action(pending == "resume" ? "Resuming…" : "Resume goal", id: "goal.resume", primary: true) { send("resume") } }
                    if goal.canClear { action(pending == "clear" ? "Clearing…" : "Clear goal", id: "goal.clear", primary: false) { confirmingClear = true } }
                }
            }
            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.md)
        }
    }
    private func send(_ name: String) {
        pending = name
        problem = nil
        Task {
            problem = await change(name)
            pending = nil
        }
    }
    @ViewBuilder private func action(_ title: String, id: String, primary: Bool, run: @escaping () -> Void) -> some View {
        let button = Button(action: run) {
            Text(title).fontWeight(.medium).frame(maxWidth: .infinity)
                .foregroundStyle(primary ? AceTheme.Colours.onAccent : AceTheme.Colours.foreground)
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .disabled(pending != nil)
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
    var act: (QueueRow.Action) async -> Bool = { _ in false }
    var showMore: () -> Void = {}
    var words: (String) async -> WordsRequests.Answer = { _ in WordsRequests.unsent }
    var saveWords: (String, String) async -> String? = { _, _ in nil }
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                QueueList(queue: queue, canAct: canAct, canSteer: canSteer, edit: edit, act: act, showMore: showMore,
                          words: words, saveWords: saveWords)
                    .padding(.horizontal, AceTheme.Spacing.xl).padding(.top, AceTheme.Spacing.sm)
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Queued")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
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
