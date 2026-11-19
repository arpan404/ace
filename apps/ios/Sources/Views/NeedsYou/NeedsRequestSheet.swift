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
        switch request.kind {
        case "question":
            QuestionCard(interaction: request, submission: submission, canAct: model.canOperate, draft: $draft) {
                model.answerNeed(request, in: threadId, answers: $0, dismissed: $1)
            }.id(request.id)
        case "plan_review":
            PlanReviewCard(interaction: request, submission: submission, canAct: model.canOperate) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        case "elicitation":
            FormRequestCard(interaction: request, submission: submission, canAct: model.canOperate) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        case "browser_help":
            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate, openBrowser: open) {
                model.answerNeed(request, in: threadId, answer: $0)
            }.id(request.id)
        default:
            ApprovalCard(approval: request, submission: submission, canAct: model.canOperate) {
                model.approveNeed(request, in: threadId, option: $0)
            }.id(request.id)
        }
    }
}
