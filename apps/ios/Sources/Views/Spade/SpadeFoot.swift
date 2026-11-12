import SwiftUI

/// The oldest approval Spade waits on, as the thread's request strip: its one sentence ("Spade
/// wants to send an email."), how many more wait, then Decline, Allow always and Allow; Details
/// shows the call's arguments. A taken answer keeps the buttons off until Spade stores it and
/// the strip moves on.
struct SpadeApprovalStrip: View {
    let approval: SpadeModel.Approval
    /// Resolves whether Spade took the answer.
    let answer: (_ allowed: Bool, _ always: Bool) async -> Bool
    @State private var sending = false
    @State private var details = false

    var body: some View {
        DockStrip(line: StripLineRow(lead: StripLeadRow(icon: "approve", tone: "needs-you"), sentence: approval.sentence,
                                     detail: approval.more > 0 ? "\(approval.more) more" : ""),
                  actions: actions, identifier: "spade.approval")
            .id(approval.callId)
            .sensoryFeedback(AceDesign.Haptic.approve, trigger: sending) { _, now in now }
            .sheet(isPresented: $details) {
                NavigationStack {
                    ScrollView {
                        Text(verbatim: approval.details ?? "")
                            .aceMonospace(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(AceDesign.Space.margin)
                    }
                    .navigationTitle(approval.sentence)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { details = false } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                        }
                    }
                }
                .presentationDetents([.medium, .large])
            }
    }

    private var actions: [DockAction] {
        let more = approval.details == nil ? [] : [DockAction(id: "details", label: "Details", identifier: "spade.approval.details", aside: true) { details = true }]
        return more + [
            DockAction(id: "decline", label: "Decline", enabled: !sending, identifier: "spade.approval.decline") { send(false, false) },
            DockAction(id: "always", label: "Allow always", enabled: !sending, identifier: "spade.approval.always") { send(true, true) },
            DockAction(id: "allow", label: "Allow", primary: true, enabled: !sending, identifier: "spade.approval.allow") { send(true, false) },
        ]
    }

    private func send(_ allowed: Bool, _ always: Bool) {
        sending = true
        Task { if !(await answer(allowed, always)) { sending = false } }
    }
}

/// Spade's composer capsule: the field, and Send. While a reply is open a message steers it;
/// while Spade isn't running the field says why and nothing sends.
struct SpadeComposer: View {
    @Binding var text: String
    let placeholder: String
    /// Why nothing can be sent now; nil when Spade is running.
    let blocked: String?
    let sending: Bool
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        HStack(alignment: .bottom, spacing: AceTheme.Spacing.none) {
            TextField(blocked ?? placeholder, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                .focused($focused)
                .disabled(blocked != nil)
                .padding(.leading, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
                .frame(minHeight: AceDesign.Size.tap)
                .accessibilityIdentifier("spade.composer")
            ComposerActionButton(saving: sending, disabled: empty || blocked != nil || sending, label: "Send", action: send)
                .padding(.trailing, AceDesign.Space.tight)
                .padding(.bottom, AceTheme.Spacing.xxs)
                .accessibilityIdentifier("spade.send")
        }
        .composerGlass(in: AceShape.field)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: sending) { _, now in now }
    }
}
