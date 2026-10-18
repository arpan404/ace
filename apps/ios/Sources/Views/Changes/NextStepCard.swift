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
/// action. Commit and Create PR open their editor (with an AI draft on request); Merge uses the
/// method the person last picked on this phone and asks to confirm; an open PR can ask for review.
struct NextStepCard: View {
    @Bindable var model: ClientModel
    let summary: ChangesSummary
    let title: String
    /// The method last picked here, as the web remembers it per device. Squash until then.
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var request: String?
    @State private var editing = false
    @State private var confirmingMerge = false
    @State private var requestingReview = false
    @State private var reviewers = ""
    private var step: ChangesSummary.Step { summary.step }
    private var outcome: GitOutcome? { request.flatMap { model.sheets.outcomes[$0] } }
    private var running: Bool { summary.busy || (request != nil && outcome == nil) }
    private var methods: [MergeMethodOption] { summary.methods ?? [] }
    private var method: MergeMethodOption? { methods.first { $0.method == savedMethod } ?? methods.first }
    private var label: String { step.kind == "merge" ? method?.label ?? step.label : step.label }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            HStack(spacing: AceTheme.Spacing.md) {
                Image(systemName: icon).frame(width: AceTheme.Dimensions.touchTarget * 0.7, height: AceTheme.Dimensions.touchTarget * 0.7)
                    .background(AceTheme.Colours.diffAdd, in: RoundedRectangle(cornerRadius: AceTheme.Radii.small))
                    .foregroundStyle(AceTheme.StatusText.done)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(heading).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    Text(step.blocked ?? step.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3)
                }
                .accessibilityElement(children: .combine)
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
                ViewThatFits(in: .horizontal) {
                    HStack { secondary; Spacer(minLength: AceTheme.Spacing.none); primary }
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) { primary; secondary }
                }
            }
        }
        .padding(AceTheme.Spacing.lg)
        .floatingGlass()
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.sm)
        .sheet(isPresented: $editing) {
            GitMessageSheet(model: model, kind: step.kind, submitLabel: step.label, initialTitle: title) { send($0) }
        }
        .confirmationDialog("\(label) PR #\(step.pr?.number ?? 0)?", isPresented: $confirmingMerge, titleVisibility: .visible) {
            Button(label) { send(["kind": "merge", "method": method?.method ?? "squash"]) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Request review", isPresented: $requestingReview) {
            TextField("ana, bo", text: $reviewers).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("changes.reviewers")
            Button("Cancel", role: .cancel) {}
            Button("Request review") { send(["kind": "request-review", "reviewers": reviewers]) }
                .disabled(reviewers.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: { Text("GitHub usernames") }
    }
    private var primary: some View {
        Button { start() } label: {
            if running { ProgressView() } else { Text(label) }
        }
        .buttonStyle(.borderedProminent).tint(AceTheme.Colours.accent)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .disabled(step.blocked != nil || running)
        .accessibilityIdentifier("changes.step")
    }
    @ViewBuilder private var secondary: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let url = step.pr?.url.flatMap(URL.init(string:)) { Link("Open on GitHub", destination: url).buttonStyle(.bordered) }
            if step.kind == "merge" {
                Menu {
                    Picker("Merge method", selection: Binding(get: { method?.method ?? "" }, set: { savedMethod = $0 })) {
                        ForEach(methods) { Text($0.label).tag($0.method) }
                    }
                    Button("Request review", systemImage: "person.badge.plus") { reviewers = ""; requestingReview = true }
                } label: {
                    Image(systemName: "ellipsis.circle").frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                }
                .disabled(running)
                .accessibilityLabel("Merge options")
                .accessibilityValue(method?.label ?? "")
                .accessibilityIdentifier("changes.mergeOptions")
            }
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
        case "commit", "create-pr": editing = true
        case "merge": confirmingMerge = true
        default: send(["kind": step.kind])
        }
    }
    private func send(_ action: [String: Any]) { request = model.gitStep(action) }
}
