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

/// The Changes sheet's git steps: the next step towards a merged change (the same rules as the
/// web's git action) as the toolbar's branch button, and the rest in its ⋯ menu. Commit and
/// Create PR open their editor (with an AI draft on request); Merge uses the method last picked
/// on this phone and asks to confirm; an open PR can ask for review. Progress and the outcome
/// float above the bottom edge.
private struct ChangesActions: ViewModifier {
    @Bindable var model: ClientModel
    let summary: ChangesSummary?
    let title: String
    @Binding var wrap: Bool
    /// The method last picked here, as the web remembers it per device. Squash until then.
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var request: String?
    @State private var editing = false
    @State private var confirmingMerge = false
    @State private var requestingReview = false
    @State private var reviewers = ""
    private var step: ChangesSummary.Step? { summary?.state == "ready" ? summary?.step : nil }
    private var outcome: GitOutcome? { request.flatMap { model.sheets.outcomes[$0] } }
    private var running: Bool { summary?.busy == true || (request != nil && outcome == nil) }
    private var methods: [MergeMethodOption] { summary?.methods ?? [] }
    private var method: MergeMethodOption? { methods.first { $0.method == savedMethod } ?? methods.first }
    private func label(_ step: ChangesSummary.Step) -> String { step.kind == "merge" ? method?.label ?? step.label : step.label }

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    menu
                    if let step, step.kind != "none", model.canOperate { stepButton(step) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { status }
            .sheet(isPresented: $editing) {
                if let step { GitMessageSheet(model: model, kind: step.kind, submitLabel: step.label, initialTitle: title) { send($0) } }
            }
            .confirmationDialog("\(step.map(label) ?? "Merge") PR #\(step?.pr?.number ?? 0)?", isPresented: $confirmingMerge, titleVisibility: .visible) {
                Button(step.map(label) ?? "Merge") { send(["kind": "merge", "method": method?.method ?? "squash"]) }
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

    /// The next step itself, one tap away.
    private func stepButton(_ step: ChangesSummary.Step) -> some View {
        Button { start(step) } label: {
            if running { ProgressView() } else { Text(label(step)).fontWeight(.medium) }
        }
        .disabled(step.blocked != nil || running)
        .accessibilityLabel(label(step))
        .accessibilityHint(step.blocked ?? step.detail)
        .accessibilityIdentifier("changes.step")
    }
    private var menu: some View {
        Menu {
            if let step, step.kind != "none", model.canOperate {
                Section(step.blocked ?? step.detail) {
                    Button { start(step) } label: { Label(label(step), systemImage: icon(step)) }
                        .disabled(step.blocked != nil || running)
                    if step.kind == "merge" {
                        Picker("Merge method", selection: Binding(get: { method?.method ?? "" }, set: { savedMethod = $0 })) {
                            ForEach(methods) { Text($0.label).tag($0.method) }
                        }
                        .pickerStyle(.menu)
                        .accessibilityIdentifier("changes.mergeOptions")
                        Button("Request review", systemImage: "person.badge.plus") { reviewers = ""; requestingReview = true }
                    }
                }
            }
            if let url = step?.pr?.url.flatMap(URL.init(string:)) { Link(destination: url) { Label("Open on GitHub", systemImage: "safari") } }
            Section {
                Toggle(isOn: $wrap) { Label("Wrap lines", systemImage: "text.word.spacing") }
                    .accessibilityIdentifier("diff.wrap")
                Button("Refresh", systemImage: "arrow.clockwise") { model.sheet(["kind": "changes.refresh"]) }
            }
        } label: { Image(systemName: "ellipsis") }
        .accessibilityLabel("Change actions").accessibilityIdentifier("changes.menu")
    }

    /// A step in flight, its outcome, or why this phone can't take one.
    @ViewBuilder private var status: some View {
        let text: (String, Color)? = {
            if let outcome { return (outcome.message, outcome.ok ? AceTheme.StatusText.done : AceTheme.StatusText.failed) }
            if running, let step { return ("\(label(step))…", AceTheme.Colours.mutedForeground) }
            if !model.canOperate && summary?.state == "ready" { return ("View only: this phone can't commit, push or merge.", AceTheme.Colours.mutedForeground) }
            return nil
        }()
        if let (message, colour) = text {
            HStack(spacing: AceTheme.Spacing.sm) {
                if running { ProgressView().controlSize(.small) }
                Text(message).foregroundStyle(colour).lineLimit(3)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            .aceGlass(in: Capsule())
            .padding(.bottom, AceTheme.Spacing.sm)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier(outcome != nil ? "changes.outcome" : model.canOperate ? "changes.running" : "changes.readOnly")
        }
    }
    private func icon(_ step: ChangesSummary.Step) -> String {
        switch step.kind {
        case "commit": "checkmark.circle"
        case "push": "arrow.up.circle"
        case "merge": "arrow.triangle.merge"
        default: "arrow.triangle.branch"
        }
    }
    private func start(_ step: ChangesSummary.Step) {
        switch step.kind {
        case "commit", "create-pr": editing = true
        case "merge": confirmingMerge = true
        default: send(["kind": step.kind])
        }
    }
    private func send(_ action: [String: Any]) { request = model.gitStep(action) }
}

extension View {
    func changesActions(model: ClientModel, summary: ChangesSummary?, title: String, wrap: Binding<Bool>) -> some View {
        modifier(ChangesActions(model: model, summary: summary, title: title, wrap: wrap))
    }
}
