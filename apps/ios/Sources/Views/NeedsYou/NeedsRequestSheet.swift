import SwiftUI

/// A request answered from outside its thread, on the thread's own cards (question, plan, form,
/// approval), answering through the inbox's path. Browser help is answered in the thread.
struct NeedsRequestCard: View {
    let request: ApprovalRow
    let model: ClientModel
    let threadId: String
    let open: () -> Void
    @Binding var draft: QuestionDraftState
    var body: some View {
        let submission = model.approvalSubmissions[request.id]
        // A summarized request loads in full on demand, so a yes names the version shown (ADR 0157).
        let retry = { model.readNeed(request, in: threadId, retry: true) }
        Group {
            card(submission, retry: retry)
        }
        .task(id: request.id) {
            if request.tooLargeToApprove { model.readNeed(request, in: threadId) }
        }
    }

    @ViewBuilder private func card(_ submission: ApprovalSubmission?, retry: @escaping () -> Void) -> some View {
        switch request.kind {
        case "question":
            QuestionCard(interaction: request, submission: submission, canAct: model.canOperate, draft: $draft, retry: retry) {
                model.answerNeed(request, in: threadId, answers: $0, dismissed: $1)
            }.id(request.id)
        case "plan_review":
            PlanReviewCard(interaction: request, submission: submission, canAct: model.canOperate,
                           onRead: { model.readNeed(request, in: threadId) }, retry: retry) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        case "elicitation":
            FormRequestCard(interaction: request, submission: submission, canAct: model.canOperate, retry: retry) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        case "browser_help":
            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate, openBrowser: open) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        default:
            ApprovalCard(approval: request, submission: submission, canAct: model.canOperate, retry: retry) {
                model.approveNeed(request, in: threadId, option: $0)
            }.id(request.id)
        }
    }
}
