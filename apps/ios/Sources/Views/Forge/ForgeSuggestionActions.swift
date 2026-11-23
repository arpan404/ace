import SwiftUI

/// Under a reviewer's suggested change: Commit suggestion and Add to batch while GitHub can
/// commit it at the head shown, or Ask the agent once a push outdated it or GitHub refused it.
/// Commit opens its message, prefilled as GitHub prefills it.
struct ForgeSuggestionActions: View {
    let comment: ForgeComment
    let suggestion: ForgeComment.Suggestion
    let actions: ForgeCommentActions

    private var desk: ForgeReviewDesk { actions.desk }

    var body: some View {
        HStack(spacing: AceTheme.Spacing.lg) {
            if suggestion.commit {
                Button("Commit suggestion") { commit() }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("forge.suggestion.commit.\(comment.commentId)")
                let batched = desk.batch.contains(comment.commentId, at: suggestion.headSha)
                Button(batched ? "Remove from batch" : "Add to batch") {
                    withAnimation { desk.toggleBatch(comment.commentId, suggestion) }
                }
                .accessibilityIdentifier("forge.suggestion.batch.\(comment.commentId)")
            }
            if (!suggestion.commit || desk.refused.contains(comment.commentId)), desk.fix != nil {
                Button("Ask the agent") { ask() }
                    .accessibilityIdentifier("forge.suggestion.agent.\(comment.commentId)")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .disabled(!desk.ready)
    }

    private func commit() {
        let desk = desk, id = comment.commentId, head = suggestion.headSha
        actions.compose(ForgeCompose(
            title: "Commit suggestion", text: suggestion.message, placeholder: "Commit message",
            primary: .init(label: "Commit changes") { message in
                await desk.commitSuggestions([id], at: head, message: message)
            }))
    }

    private func ask() {
        guard let fix = desk.fix else { return }
        let desk = desk, request = suggestion.agent
        Task {
            if await !fix(request) {
                desk.report("Couldn't hand this to an agent. Open the pull request's thread and try again.")
            }
        }
    }
}

/// The suggestions picked to commit together: how many, Clear, and one commit for them all at
/// the head they were picked at.
struct ForgeSuggestionBatchBar: View {
    let desk: ForgeReviewDesk
    let compose: (ForgeCompose) -> Void

    var body: some View {
        let count = desk.batch.ids.count
        if count > 0 {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(count == 1 ? "1 suggestion in batch" : "\(count) suggestions in batch")
                    .monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button("Clear") { withAnimation { desk.batch.clear() } }
                    .accessibilityIdentifier("forge.batch.clear")
                Button(count == 1 ? "Commit suggestion" : "Commit \(count) suggestions") { commit() }
                    .buttonStyle(.textAction(.prominent))
                    .accessibilityIdentifier("forge.batch.commit")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .frame(minHeight: AceDesign.Size.tap)
            .disabled(!desk.ready)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("forge.batch")
        }
    }

    private func commit() {
        guard let head = desk.batch.head else { return }
        let desk = desk, ids = desk.batch.ids
        compose(ForgeCompose(
            title: ids.count == 1 ? "Commit suggestion" : "Commit \(ids.count) suggestions",
            text: desk.batch.message, placeholder: "Commit message",
            primary: .init(label: "Commit changes") { message in
                await desk.commitSuggestions(ids, at: head, message: message)
            }))
    }
}
