import SwiftUI

/// One Work write at a time, from the sheet or the thread's problem line: the request in flight,
/// its outcome as the bridge reported it, and the question uncommitted changes raised. A move
/// stopped by uncommitted changes is sent again only after the person says so, and only once.
@MainActor @Observable final class WorkRunner {
    private(set) var request: String?
    /// The action sent last, kept to send again with the changes carried along.
    @ObservationIgnored private var sent: [String: Any]?
    /// The question to ask before sending `sent` again.
    var asking: WorkResult.Ask?

    func result(in model: ClientModel) -> WorkResult? { request.flatMap { model.sheets.workResults[$0] } }
    /// Sent and not answered yet.
    func running(in model: ClientModel) -> Bool { request != nil && result(in: model) == nil }

    func send(_ action: [String: Any], model: ClientModel) {
        guard !running(in: model) else { return }
        sent = action
        request = model.workAction(action)
    }
    func clearLock(model: ClientModel) {
        guard !running(in: model) else { return }
        sent = nil
        request = model.clearStaleLock()
    }
    /// The bridge answered: a move that met uncommitted changes asks first.
    func answered(_ result: WorkResult?) {
        if let ask = result?.ask { asking = ask }
    }
    func carryAlong(model: ClientModel) {
        guard var action = sent else { return }
        action["allowUncommitted"] = true
        asking = nil
        request = model.workAction(action)
    }
}

private struct WorkQuestions: ViewModifier {
    let runner: WorkRunner
    let model: ClientModel
    @Binding var confirmingLock: Bool

    func body(content: Content) -> some View {
        let result = runner.result(in: model)
        content
            .onChange(of: result) { _, next in runner.answered(next) }
            .sensoryFeedback(trigger: result) { _, next in
                guard let next, next.ask == nil else { return nil }
                return next.ok ? .success : .error
            }
            .confirmationDialog(runner.asking?.title ?? "", isPresented: Binding(get: { runner.asking != nil }, set: { if !$0 { runner.asking = nil } }),
                                titleVisibility: .visible, presenting: runner.asking) { ask in
                Button(ask.confirm) { runner.carryAlong(model: model) }.accessibilityIdentifier("work.carryAlong")
                Button("Cancel", role: .cancel) { runner.asking = nil }
            } message: { ask in Text(ask.detail) }
            .confirmationDialog("Clear the stale Git lock?", isPresented: $confirmingLock, titleVisibility: .visible) {
                Button("Clear lock", role: .destructive) { runner.clearLock(model: model) }.accessibilityIdentifier("work.clearLock.confirm")
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("A Git operation an earlier ace daemon started never confirmed its cleanup. ace clears the lock only after checking that daemon has stopped. Continue only if nothing it started is still changing these files.")
            }
    }
}

extension View {
    /// The questions a Work write may raise: carry uncommitted changes along, or clear a stale
    /// lock. Haptics mark each outcome.
    func workQuestions(runner: WorkRunner, model: ClientModel, confirmingLock: Binding<Bool>) -> some View {
        modifier(WorkQuestions(runner: runner, model: model, confirmingLock: confirmingLock))
    }
}

/// A text button in ace's words: no icon, a 44pt target. Destructive ones read red.
struct WorkWordButton: View {
    let label: String
    var destructive = false
    var identifier = ""
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).fontWeight(.medium)
                .padding(.horizontal, AceTheme.Spacing.sm)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(destructive ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
        .accessibilityIdentifier(identifier)
    }
}
