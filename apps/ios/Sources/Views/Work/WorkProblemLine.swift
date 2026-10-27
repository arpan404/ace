import SwiftUI

extension EnvironmentValues {
    /// Asks to clear the open thread's stale Git lock (with its confirmation); nil where this
    /// phone can't act.
    @Entry var clearStaleLock: (() -> Void)? = nil
}

/// What stops the open thread's checkout, above its composer in the composer's one strip, as the
/// bridge words it (`bridge/work-line.ts`): "Checkout move failed  Retry  Change checkout",
/// "Setup script failed  Retry  Continue without setup", "Git is locked  Clear stale lock". Its
/// outcome replaces the second line until the problem goes; Change checkout opens Work.
struct WorkProblemLine: View {
    let model: ClientModel
    let line: WorkLine
    let runner: WorkRunner
    let openWork: () -> Void
    let confirmLock: () -> Void

    var body: some View {
        StripSurface {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(line.label).fontWeight(.medium).foregroundStyle(AceTheme.StatusText.failed)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.canOperate {
                        ForEach(line.actions) { action in
                            Button(action.label) { run(action) }
                                .buttonStyle(StripTextButtonStyle())
                                .disabled(runner.running(in: model))
                                .accessibilityIdentifier("thread.work.\(action.id)")
                        }
                    }
                }
                if let words = second, !words.isEmpty {
                    Text(words).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                        .accessibilityIdentifier("thread.work.detail")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            .accessibilityElement(children: .contain)
        }
        .accessibilityIdentifier("thread.work")
        .onAppear { AccessibilityNotification.Announcement(line.label).post() }
    }

    /// The outcome of the last way out tried, else why.
    private var second: String? {
        if runner.running(in: model) { return "Working on it…" }
        if let result = runner.result(in: model), result.ask == nil, !result.message.isEmpty { return result.message }
        return line.detail
    }
    private func run(_ action: WorkAction) {
        switch action.id {
        case "open-work": openWork()
        case "lock.clear": confirmLock()
        default: runner.send(["kind": "problem", "id": action.id], model: model)
        }
    }
}

/// "Clear stale lock" on a Not sent line, where Git's cleanup fence stopped the message.
struct ClearStaleLockWord: View {
    @Environment(\.clearStaleLock) private var clear
    var body: some View {
        if let clear {
            Button("Clear stale lock", action: clear)
                .fontWeight(.medium)
                .foregroundStyle(AceTheme.StatusText.failed)
                .padding(.horizontal, AceTheme.Spacing.sm)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
                .accessibilityIdentifier("thread.clearStaleLock")
        }
    }
}
