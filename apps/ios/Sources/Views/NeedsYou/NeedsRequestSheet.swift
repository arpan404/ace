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

/// A row's Answer or Review: the request in a native sheet, a plan as the thread's plan review.
struct NeedsRequestSheet: View {
    let request: ApprovalRow
    let model: ClientModel
    let threadId: String
    let open: () -> Void
    let close: () -> Void
    @State private var draft = QuestionDraftState()
    var body: some View {
        if request.kind == "plan_review" {
            PlanReviewSheet(plan: request.plan, submission: model.approvalSubmissions[request.id], canAct: model.canOperate) { answer in
                close()
                model.answerNeed(request, in: threadId, answer: answer)
            }
        } else {
            NavigationStack {
                ScrollView {
                    NeedsRequestCard(request: request, model: model, threadId: threadId, open: { close(); open() }, draft: $draft)
                        .padding(.horizontal, AceDesign.Space.margin)
                        .padding(.vertical, AceDesign.Space.row)
                }
                .navigationTitle(request.kind == "question" ? "Question" : request.kind == "elicitation" ? "Details" : "Approval")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(action: close) { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("need.close")
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }
}
