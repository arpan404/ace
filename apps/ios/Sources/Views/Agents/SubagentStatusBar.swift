import SwiftUI

/// What stands in the composer's place under a subagent, which nobody but its parent can message:
/// its provider and model, how its whole branch stands (ticking while it runs), and its one action.
/// Stop while it runs (asking first when subagents stop with it); once it failed or was stopped,
/// Ask parent to retry, which only ever sends on the press and then says where the message went.
/// A view-only phone sees the state and no controls.
struct SubagentStatusBar: View {
    let info: SubagentInfo
    let model: ClientModel
    @State private var stop = StopConfirmation()
    @State private var retry = RetryState.idle
    @State private var problem: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum RetryState: Equatable { case idle, sending, queued, sent }

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.sm))
                             : AnyLayout(HStackLayout(spacing: AceTheme.Spacing.md))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            layout {
                HStack(spacing: AceTheme.Spacing.sm) {
                    ProviderMark(provider: info.provider, size: 16).foregroundStyle(AceTheme.Colours.foreground)
                    Text(info.model).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.medium)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                    Text(verbatim: "·").foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
                    state.layoutPriority(1)
                }
                if !stacked { Spacer(minLength: AceTheme.Spacing.xs) }
                action
            }
            if let problem {
                Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.StatusText.failed).transition(.opacity)
            }
        }
        .padding(.leading, AceTheme.Spacing.lg).padding(.trailing, AceTheme.Spacing.sm)
        .padding(.vertical, AceTheme.Spacing.xs)
        .frame(minHeight: AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xs)
        .modifier(ComposerFrame())
        .animation(reduceMotion ? nil : .smooth, value: retry)
        .animation(reduceMotion ? nil : .smooth, value: info.phase)
        .animation(reduceMotion ? nil : .smooth, value: problem)
        .sensoryFeedback(.success, trigger: retry == .queued || retry == .sent)
        // A later ending (it was retried and ended again) can be asked about again.
        .onChange(of: info.endedAt) { _, _ in retry = .idle }
        .confirmationDialog(stop.asking?.title ?? "", isPresented: Binding(get: { stop.asking != nil }, set: { if !$0 { stop.cancel() } }), titleVisibility: .visible) {
            Button("Stop", role: .destructive) {
                Task {
                    await stop.confirm(send: send)
                    if case .failed = stop.phase { problem = "Couldn't stop it. Check the connection and try again." }
                }
            }
            .accessibilityIdentifier("subagent.confirmStop")
            Button("Cancel", role: .cancel) { stop.cancel() }
        } message: { Text(stop.asking?.message ?? "") }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent.bar")
    }

    /// "Working for 1m 4s" ticking from the daemon's start, else the bridge's settled words.
    @ViewBuilder private var state: some View {
        Group {
            if info.phase == "running" {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Working for \(Elapsed.words(since: info.startedAt, now: context.date))")
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            } else {
                Text(info.status.label).foregroundStyle(loud ? StateStyle.text(info.status.token) : AceTheme.Colours.mutedForeground)
            }
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(loud ? .medium : .regular)
        .monospacedDigit().lineLimit(1)
        .accessibilityIdentifier("subagent.state")
    }
    /// Only needs-you and failed are loud.
    private var loud: Bool { info.status.token == "needsYou" || info.status.token == "failed" }

    @ViewBuilder private var action: some View {
        if !model.canOperate {
            EmptyView()
        } else if info.stoppable {
            Button(stop.saving ? "Stopping…" : "Stop") {
                problem = nil
                Task {
                    await stop.request(.agent(id: info.agentId, name: info.name, descendants: info.descendants), send: send)
                    if case .failed = stop.phase { problem = "Couldn't stop it. Check the connection and try again." }
                }
            }
            .buttonStyle(BarWordStyle(tint: AceTheme.StatusText.failed))
            .disabled(stop.saving)
            .accessibilityIdentifier("subagent.stop")
        } else if let label = info.retry?.label {
            switch retry {
            case .queued, .sent:
                Text(retry == .queued ? "Queued for parent" : "Sent to parent")
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("subagent.retried")
                    .transition(.opacity)
            case .idle, .sending:
                Button(retry == .sending ? "Asking…" : label) { Task { await askParent() } }
                    .buttonStyle(BarWordStyle(tint: AceTheme.Colours.foreground))
                    .disabled(retry == .sending)
                    .accessibilityIdentifier("subagent.retry")
                    .transition(.opacity)
            }
        }
    }

    private func send(_ target: StopConfirmation.Target) async -> Bool { await model.interrupt(agentId: target.agentId) }
    private func askParent() async {
        problem = nil
        retry = .sending
        let busy = info.parentBusy
        if await model.retrySubagent(info.agentId) {
            retry = busy ? .queued : .sent
        } else {
            retry = .idle
            problem = "Couldn't reach the parent. Try again."
        }
    }
}

/// A word in the status bar: semibold in its tint, the soft fill while pressed, 44pt tall.
struct BarWordStyle: ButtonStyle {
    let tint: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.semibold)
            .foregroundStyle(tint)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .contentShape(AceShape.capsule)
            .animation(.smooth(duration: 0.15), value: configuration.isPressed)
    }
}
