import SwiftUI

extension ClientModel {
    /// One git step for the open thread's Changes sheet (`bridge/git-actions.ts`). Returns the
    /// request id its `git.result` will carry, or nil when this phone may not act.
    func gitStep(_ action: [String: Any]) -> String? {
        guard canOperate else { return nil }
        let id = "git-\(UUID().uuidString)"
        return sheet(["kind": "git", "action": action, "requestId": id]) ? id : nil
    }
}

/// The bottom card: the next step towards a merged change, from the same rules as the web's git
/// action. Commit and Create PR ask for their message or title first; Merge asks to confirm.
struct NextStepCard: View {
    @Bindable var model: ClientModel
    let summary: ChangesSummary
    let title: String
    @State private var request: String?
    @State private var text = ""
    @State private var editing = false
    @State private var confirmingMerge = false
    private var step: ChangesSummary.Step { summary.step }
    private var outcome: GitOutcome? { request.flatMap { model.sheets.outcomes[$0] } }
    private var running: Bool { summary.busy || (request != nil && outcome == nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            HStack(spacing: AceTheme.Spacing.md) {
                Image(systemName: icon).frame(width: AceTheme.Dimensions.touchTarget * 0.7, height: AceTheme.Dimensions.touchTarget * 0.7)
                    .background(AceTheme.Colours.diffAdd, in: RoundedRectangle(cornerRadius: AceTheme.Radii.small))
                    .foregroundStyle(AceTheme.StatusText.done)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(heading).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    Text(step.blocked ?? step.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3)
                }
            }
            if let outcome {
                Text(outcome.message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(outcome.ok ? AceTheme.StatusText.done : AceTheme.StatusText.failed)
                    .accessibilityIdentifier("changes.outcome")
            }
            if !model.canOperate {
                Text("View only: this phone can't commit, push or merge.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("changes.readOnly")
            } else if step.kind != "none" {
                HStack {
                    if let url = step.pr?.url.flatMap(URL.init(string:)) { Link("Open on GitHub", destination: url).buttonStyle(.bordered) }
                    Spacer(minLength: AceTheme.Spacing.none)
                    Button { start() } label: {
                        if running { ProgressView() } else { Text(step.label) }
                    }
                    .buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
                    .disabled(step.blocked != nil || running)
                    .accessibilityIdentifier("changes.step")
                }
            }
        }
        .padding(AceTheme.Spacing.lg)
        .floatingGlass()
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.sm)
        .alert(step.kind == "commit" ? "Commit message" : "Pull request title", isPresented: $editing) {
            TextField(step.kind == "commit" ? "Message" : "Title", text: $text).accessibilityIdentifier("changes.text")
            Button("Cancel", role: .cancel) {}
            Button(step.label) { send(step.kind == "commit" ? ["kind": "commit", "message": text, "push": true] : ["kind": "create-pr", "title": text]) }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("\(step.label) PR #\(step.pr?.number ?? 0)?", isPresented: $confirmingMerge, titleVisibility: .visible) {
            Button(step.label) { send(["kind": "merge"]) }
            Button("Cancel", role: .cancel) {}
        }
    }
    private var heading: String {
        switch step.kind {
        case "commit": "Ready to commit"
        case "push": "Commits to push"
        case "create-pr": "Ready for a pull request"
        case "merge": step.pr.map { "PR #\($0.number)\($0.state == "draft" ? " · draft" : "")" } ?? "Pull request"
        default: step.label
        }
    }
    private var icon: String {
        switch step.kind {
        case "commit": "checkmark.circle"
        case "push": "arrow.up.circle"
        case "merge": "arrow.triangle.merge"
        default: "arrow.triangle.branch"
        }
    }
    private func start() {
        switch step.kind {
        case "commit", "create-pr": text = title; editing = true
        case "merge": confirmingMerge = true
        default: send(["kind": step.kind])
        }
    }
    private func send(_ action: [String: Any]) { request = model.gitStep(action) }
}
