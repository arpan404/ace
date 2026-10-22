import SwiftUI

extension ClientModel {
    /// Ask the daemon's writer for a draft of this step's text (`bridge/git-drafts.ts`). Returns the
    /// request id its `git.draft` patch carries.
    func draftGitText(for step: String) -> String? {
        guard canOperate else { return nil }
        let id = "draft-\(UUID().uuidString)"
        return sheet(["kind": "git.draft", "for": step, "requestId": id]) ? id : nil
    }
    func cancelGitDraft(_ id: String) { sheet(["kind": "git.draft.cancel", "requestId": id]) }
}

/// What a commit or a pull request says before it goes: subject or title, an optional body or
/// summary, reviewers for a PR, and the daemon's AI draft on request, as the web's git dialog
/// offers. A draft fills the fields; the person can edit them before sending.
struct GitMessageSheet: View {
    @Bindable var model: ClientModel
    /// `commit` or `create-pr`.
    let kind: String
    let submitLabel: String
    let initialTitle: String
    let send: (_ action: [String: Any]) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var reviewers = ""
    @State private var drafting: String?
    /// The last draft asked for here, so an earlier sheet's failure never shows.
    @State private var requested: String?
    /// The fields hold a draft the bridge kept the fingerprint of.
    @State private var drafted = false
    @FocusState private var focused: Bool
    private var commit: Bool { kind == "commit" }
    private var draft: GitDraft? { requested.flatMap { id in model.sheets.draft.flatMap { $0.id == id ? $0 : nil } } }
    private var failure: String? { draft?.state == "failed" ? draft?.message : nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // At accessibility sizes the subject wraps instead of scrolling out of sight;
                    // it stays one line of text either way.
                    TextField(commit ? "Summary" : "Title", text: $subject, axis: typeSize.isAccessibilitySize ? .vertical : .horizontal)
                        .onChange(of: subject) { _, text in if text.contains("\n") { subject = text.replacingOccurrences(of: "\n", with: " ") } }
                        .focused($focused).accessibilityIdentifier("changes.text")
                    TextField(commit ? "Description (optional)" : "Summary (optional)", text: $bodyText, axis: .vertical)
                        .lineLimit(3...10).accessibilityIdentifier("changes.body")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("changes.draftError") }
                }
                Section {
                    if let id = drafting {
                        Button(role: .cancel) { model.cancelGitDraft(id); drafting = nil } label: {
                            HStack(spacing: AceTheme.Spacing.sm) { ProgressView(); Text("Cancel draft") }
                        }
                        .accessibilityIdentifier("changes.cancelDraft")
                    } else {
                        Button { drafting = model.draftGitText(for: kind); requested = drafting } label: { Label("Draft with AI", systemImage: "sparkles") }
                            .accessibilityIdentifier("changes.draft")
                    }
                }
                if !commit {
                    Section {
                        TextField("Reviewers, such as ana, bo", text: $reviewers)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityLabel("Reviewers").accessibilityIdentifier("changes.reviewers")
                    }
                }
            }
            .navigationTitle(commit ? "Commit" : "Pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if let drafting { model.cancelGitDraft(drafting) }; dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitLabel) { submit() }
                        .disabled(subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || drafting != nil)
                        .accessibilityIdentifier("changes.submit")
                }
            }
            .onAppear { subject = initialTitle; focused = true }
            .onChange(of: draft) { _, draft in
                guard let draft else { return }
                switch draft.state {
                case "ready":
                    subject = draft.subject ?? subject; bodyText = draft.body ?? bodyText
                    drafted = true; drafting = nil
                case "failed", "cancelled": drafting = nil
                default: break
                }
            }
        }
        .adaptiveSheetDetents().presentationDragIndicator(.visible)
    }
    private func submit() {
        let title = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if commit {
            send(["kind": "commit", "message": description.isEmpty ? title : "\(title)\n\n\(description)", "push": true, "drafted": drafted])
        } else {
            send(["kind": "create-pr", "title": title, "summary": description, "reviewers": reviewers, "drafted": drafted])
        }
        dismiss()
    }
}
