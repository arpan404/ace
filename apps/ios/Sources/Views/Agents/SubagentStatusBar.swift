import SwiftUI

/// What stands in the composer's place under a subagent, which nobody but its parent can message:
/// its provider and model, how its whole branch stands (ticking while it runs), and its one action.
/// Stop while it runs (asking first when subagents stop with it); once it failed or was stopped,
/// Ask parent to retry, which only ever sends on the press and then says where the message went.
/// The bridge remembers the ask for that ending, so reopening the page never offers it twice.
/// A view-only phone sees the state and no controls.
struct SubagentStatusBar: View {
    let info: SubagentInfo
    let model: ClientModel
    @State private var stop = StopConfirmation()
    /// A press on its way to the bridge; afterwards the bridge's `asked` speaks.
    @State private var sending = false
    @State private var problem: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
                             : AnyLayout(HStackLayout(spacing: AceDesign.Space.row))
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            layout {
                HStack(spacing: AceDesign.Space.related) {
                    ProviderMark(provider: info.provider, size: AceDesign.Size.icon).foregroundStyle(AceDesign.Ink.primary)
                    Text(info.model).font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    Text(verbatim: "·").foregroundStyle(AceDesign.Ink.subtle).accessibilityHidden(true)
                    state.layoutPriority(1)
                }
                if !stacked { Spacer(minLength: AceDesign.Space.tight) }
                action
            }
            if let problem {
                Text(problem).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceTheme.StatusText.failed).transition(.opacity)
            }
        }
        .padding(.leading, AceDesign.Space.margin).padding(.trailing, AceDesign.Space.related)
        .padding(.vertical, AceDesign.Space.tight)
        .frame(minHeight: AceDesign.Size.tap + AceDesign.Space.tight)
        .modifier(ComposerFrame())
        .animation(.default, value: info.retry)
        .animation(.default, value: info.phase)
        .animation(.default, value: problem)
        .sensoryFeedback(.success, trigger: asked == "queued" || asked == "sent")
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
            if info.working {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("Working for \(Elapsed.words(since: info.startedAt, now: context.date))")
                        .foregroundStyle(AceDesign.Ink.muted)
                }
            } else {
                Text(info.status.label).foregroundStyle(loud ? StateStyle.text(info.status.token) : AceDesign.Ink.muted)
            }
        }
        .font(AceDesign.Typeface.body).fontWeight(loud ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
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
            switch asked {
            case "queued", "sent":
                Text(asked == "queued" ? "Queued for parent" : "Sent to parent")
                    .font(AceDesign.Typeface.body)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("subagent.retried")
                    .transition(.opacity)
            default:
                let waiting = sending || asked == "pending"
                Button(waiting ? "Asking…" : label) { Task { await askParent() } }
                    .buttonStyle(BarWordStyle(tint: AceDesign.Ink.primary))
                    .disabled(waiting)
                    .accessibilityIdentifier("subagent.retry")
                    .transition(.opacity)
            }
        }
    }
    private var asked: String? { info.retry?.asked }

    private func send(_ target: StopConfirmation.Target) async -> Bool { await model.interrupt(agentId: target.agentId) }
    private func askParent() async {
        problem = nil
        sending = true
        if !(await model.retrySubagent(info.agentId)) { problem = "Couldn't reach the parent. Try again." }
        sending = false
    }
}

/// A word in the status bar: semibold in its tint, the soft fill while pressed, 44pt tall.
struct BarWordStyle: ButtonStyle {
    let tint: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AceDesign.Typeface.body).fontWeight(.semibold)
            .foregroundStyle(tint)
            .padding(.horizontal, AceDesign.Space.row)
            .frame(minHeight: AceDesign.Size.tap)
            .background(configuration.isPressed ? AceDesign.Surface.fill : .clear, in: AceDesign.Shape.control)
            .contentShape(AceDesign.Shape.control)
    }
}
