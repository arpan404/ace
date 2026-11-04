import SwiftUI

/// The thread's open requests as one strip above the composer: the one showing, "1 of 3" with
/// ‹ › and a swipe between them, never a stack of cards. An approval answers with its own verbs
/// (Deny · Always · Allow, Allow filled); a plan says it is ready, with Review and Approve; a
/// question, a form or browser help opens in a sheet. Details, a plan or a question's options
/// open in a native sheet; the strip stays a line or two. Answering one brings the next up.
struct RequestStrip: View {
    let requests: [ApprovalRow]
    @Environment(\.aceReduceMotion) private var reduceMotion
    let model: ClientModel
    @Binding var questionDraft: QuestionDraftState
    let openBrowser: () -> Void
    @State private var index = 0
    @State private var sheet: RequestSheetItem?

    var body: some View {
        let shown = min(index, max(0, requests.count - 1))
        if requests.indices.contains(shown) {
            let request = requests[shown]
            DockStrip(line: request.strip ?? StripLineRow(lead: StripLeadRow(), sentence: request.heading ?? request.title),
                      pager: DockPager(index: shown, total: requests.count) { step in
                          withAnimation(AceDesign.Motion.arriving(reduceMotion)) { index = min(max(0, shown + step), requests.count - 1) }
                      },
                      actions: actions(for: request),
                      openPayload: request.kind == "approval" ? nil : { sheet = RequestSheetItem(id: request.id) },
                      identifier: "request.\(request.kind)")
                .id(request.id)
                .transition(.opacity)
                .sensoryFeedback(AceDesign.Haptic.approve, trigger: model.approvalSubmissions[request.id]?.requestId)
                .sheet(item: $sheet) { item in
                    if let open = requests.first(where: { $0.id == item.id }) {
                        RequestSheet(request: open, model: model, questionDraft: $questionDraft, openBrowser: openBrowser) { sheet = nil }
                    }
                }
                // The request a sheet shows was answered: the sheet goes with it.
                .onChange(of: requests.map(\.id)) { _, ids in if let item = sheet, !ids.contains(item.id) { sheet = nil } }
        }
    }

    private func actions(for request: ApprovalRow) -> [DockAction] {
        let open = model.canOperate && model.approvalSubmissions[request.id] == nil
        let review = { sheet = RequestSheetItem(id: request.id) }
        switch request.kind {
        case "approval":
            let verbs = request.verbs
            var words: [DockAction] = verbs.map { verb in
                DockAction(id: verb.option.kind, label: verb.decision.label, primary: verb.decision.emphasis == "primary",
                           enabled: open,
                           identifier: "approval.\(verb.option.kind)") { model.approve(request, option: verb.option) }
            }
            if verbs.isEmpty {
                // A daemon that sends no verbs: Deny and Allow once, as offered.
                words = request.options.filter { $0.kind == "deny" || $0.kind == "allow_once" }
                    .sorted { $0.kind == "deny" && $1.kind != "deny" }
                    .map { option in
                        DockAction(id: option.kind, label: option.label, primary: option.kind == "allow_once",
                                   enabled: open,
                                   identifier: "approval.\(option.kind)") { model.approve(request, option: option) }
                    }
            }
            // The reason and any other option are the sheet's.
            let more = !(request.reason ?? "").isEmpty || !(request.description.isEmpty) || !request.remaining.isEmpty
            return (more ? [DockAction(id: "details", label: "Details", identifier: "approval.details", aside: true, run: review)] : []) + words
        case "plan_review":
            return [DockAction(id: "review", label: "Review", identifier: "plan.review", run: review),
                    DockAction(id: "approve", label: "Approve", primary: true, enabled: open, identifier: "plan.approve") {
                        model.resolve(request, answer: ["kind": "plan", "decision": "approve"])
                    }]
        case "question":
            return [DockAction(id: "answer", label: "Answer", primary: true, run: review)]
        default:
            return [DockAction(id: "review", label: "Review", primary: true, run: review)]
        }
    }
}

struct RequestSheetItem: Identifiable { let id: String }

/// A request in full, in a native sheet: a plan as prose with Request changes and Approve plan,
/// a question with its options, a form, browser help, or an approval with its command, reason
/// and every option. Answering closes it.
struct RequestSheet: View {
    let request: ApprovalRow
    let model: ClientModel
    @Binding var questionDraft: QuestionDraftState
    let openBrowser: () -> Void
    let close: () -> Void
    var body: some View {
        if request.kind == "plan_review" {
            PlanReviewSheet(plan: request.plan, submission: model.approvalSubmissions[request.id], canAct: model.canOperate) { answer in
                close()
                model.resolve(request, answer: answer)
            }
        } else {
            NavigationStack {
                ScrollView {
                    RequestCard(request: request, model: model, maxHeight: .infinity, questionDraft: $questionDraft, openBrowser: openBrowser)
                        .padding(.horizontal, AceDesign.Space.margin)
                        .padding(.vertical, AceDesign.Space.row)
                }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(action: close) { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("request.close")
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }
    private var title: String {
        switch request.kind {
        case "question": "Question"
        case "elicitation": "Details"
        case "browser_help": "Browser"
        default: "Approval"
        }
    }
}

/// Commands a stopped or finished turn left running: "Running" with the command, or "Running 2
/// commands", and one Stop that ends them all.
struct LeftRunningStrip: View {
    let row: LeftRunningRow
    let canAct: Bool
    let stop: (String) async -> Void
    @State private var stopping = false
    var body: some View {
        DockStrip(line: row.strip, actions: [
            DockAction(id: "stop", label: stopping ? "Stopping…" : "Stop", primary: true, enabled: canAct && !stopping) {
                stopping = true
                Task {
                    for id in row.taskIds { await stop(id) }
                    stopping = false
                }
            },
        ], identifier: "thread.leftRunning")
    }
}

/// The message a failed send left at the head of the queue: "Not sent · why" with its opening
/// words, then Try again (filled), Edit and Remove; Remove asks first.
struct NotSentStrip: View {
    let message: QueueRow.NotSent
    let canAct: Bool
    let act: (QueueRow.Action) async -> Bool
    let edit: (QueueRow.Message, [String: Any]) async -> Bool
    let words: () async -> WordsRequests.Answer
    let saveWords: (String, Int?) async -> String?
    @State private var editor: MessageEditor?
    @State private var confirming = false
    @State private var busy = false
    @State private var recovered = 0
    var body: some View {
        let line = message.strip ?? StripLineRow(lead: StripLeadRow(icon: "approve", tone: "needs-you"),
                                                 sentence: message.reason.isEmpty ? "Not sent" : message.reason, detail: message.text)
        DockStrip(line: line, actions: [
            DockAction(id: "remove", label: "Remove", enabled: canAct && !busy, identifier: "notSent.remove") { confirming = true },
            DockAction(id: "edit", label: "Edit", enabled: canAct && !busy, identifier: "notSent.edit") {
                editor = MessageEditor(attachments: message.attachments, read: words, write: saveWords)
            },
            DockAction(id: "retry", label: "Try again", primary: true, enabled: canAct && !busy, identifier: "pending.retry") {
                run { await act(QueueRow.Action(id: "resume", label: "Try again")) }
            },
        ], identifier: "heldSend")
        .sheet(item: $editor) { MessageEditSheet(editor: $0) }
        .sensoryFeedback(.success, trigger: recovered)
        .confirmationDialog("Remove this message?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Remove message", role: .destructive) {
                let queued = QueueRow.Message(id: message.id, text: message.text, delivery: "queue", state: "queued", attachments: message.attachments)
                run { await edit(queued, ["kind": "remove"]) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It won't be sent.") }
    }
    private func run(_ action: @escaping () async -> Bool) {
        busy = true
        Task {
            if await action() { recovered += 1 }
            busy = false
        }
    }
}
