import SwiftUI

/// One open request as its card: a question, plan review, form, browser help or approval. The
/// thread's composer strip and a subagent's own view both draw requests through it.
struct RequestCard: View {
    let request: ApprovalRow
    let model: ClientModel
    let maxHeight: CGFloat
    @Binding var questionDraft: QuestionDraftState
    let openBrowser: () -> Void
    var body: some View {
        let submission = model.approvalSubmissions[request.id]
        switch request.kind {
        case "question":
            QuestionCard(interaction: request, submission: submission, canAct: model.canOperate, maxHeight: maxHeight, draft: $questionDraft) {
                model.answer(request, answers: $0, dismissed: $1)
            }.id(request.id)
        case "plan_review":
            PlanReviewCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
        case "elicitation":
            FormRequestCard(interaction: request, submission: submission, canAct: model.canOperate) { model.resolve(request, answer: $0) }.id(request.id)
        case "browser_help":
            BrowserHelpCard(interaction: request, submission: submission, canAct: model.canOperate,
                            openBrowser: openBrowser) { model.resolve(request, answer: $0) }.id(request.id)
        default:
            ApprovalCard(approval: request, submission: submission, canAct: model.canOperate) { model.approve(request, option: $0) }.id(request.id)
        }
    }
}
