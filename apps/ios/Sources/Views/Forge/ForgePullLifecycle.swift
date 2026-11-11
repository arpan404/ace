import SwiftUI

/// Where a pull request can go from its state, as words: Ready for review, Convert to draft,
/// Close, Reopen, Update branch. Closing and a rebase update ask first; the rest are one tap,
/// each pinned to the version shown by the section that sends it.
struct ForgeLifecycleRow: View {
    let steps: [ForgeManage.Step]
    let enabled: Bool
    let take: (String) -> Void
    @State private var asking: ForgeManage.Step?

    var body: some View {
        if !steps.isEmpty {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AceDesign.Space.row) { words }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) { words }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .confirmationDialog(asking?.label ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
                                titleVisibility: .visible, presenting: asking) { step in
                Button(step.label, role: step.kind == "close" ? .destructive : nil) { take(step.kind) }
            } message: { step in Text(Self.warning(step.kind)) }
        }
    }

    @ViewBuilder private var words: some View {
        ForEach(steps, id: \.self) { step in
            Button(step.label) { if Self.asks(step.kind) { asking = step } else { take(step.kind) } }
                .buttonStyle(.textAction(Self.leads(step.kind) ? .prominent : .plain))
                .disabled(!enabled)
                .accessibilityIdentifier("forge.manage.\(step.kind)")
        }
    }

    /// The way forward from a state: out of draft, open again, up to date. The rest are muted.
    static func leads(_ kind: String) -> Bool { kind == "ready" || kind == "reopen" || kind == "update.merge" }
    /// The changes that are hard to take back from a phone.
    static func asks(_ kind: String) -> Bool { kind == "close" || kind == "update.rebase" }
    static func warning(_ kind: String) -> String {
        kind == "close"
            ? "It can be reopened later. Its branch and threads stay."
            : "The branch's commits are rewritten on top of the base. Anyone with the branch checked out has to pull again."
    }
}

/// The pull request's title, description, base, labels and assignees, as far as this account may
/// change them. Saving sends only what changed, in one edit pinned to the version shown.
/// What the edit sheet opens on: the text and the version it was read at.
struct ForgePullEditTarget: Identifiable {
    let version: String
    let metadata: ForgeManage.Metadata
    let editable: [String]
    var id: String { version }
}

struct ForgePullEditSheet: View {
    let metadata: ForgeManage.Metadata
    let editable: Set<String>
    let save: ([String: Any]) async -> ForgeReviewOutcome
    @State private var title: String
    @State private var body_: String
    @State private var base: String
    @State private var labels: String
    @State private var assignees: String
    @State private var discarding = false
    @State private var saving = false
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    init(metadata: ForgeManage.Metadata, editable: [String], save: @escaping ([String: Any]) async -> ForgeReviewOutcome) {
        self.metadata = metadata
        self.editable = Set(editable)
        self.save = save
        _title = State(initialValue: metadata.title)
        _body_ = State(initialValue: metadata.body)
        _base = State(initialValue: metadata.baseBranch)
        _labels = State(initialValue: metadata.labels.joined(separator: "\n"))
        _assignees = State(initialValue: metadata.assignees.joined(separator: "\n"))
    }

    private var changes: [String: Any] {
        ForgePullEdit.changes(from: metadata, editable: editable, title: title, body: body_, base: base,
                              labels: labels, assignees: assignees)
    }
    private var valid: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem {
                        Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.StatusText.failed)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, AceDesign.Space.margin)
                            .accessibilityIdentifier("forge.edit.problem")
                    }
                    field("Title", "title") { TextField("Title", text: $title).accessibilityIdentifier("forge.edit.title") }
                    field("Description", "body") {
                        TextField("Description", text: $body_, axis: .vertical).lineLimit(4...12)
                            .accessibilityIdentifier("forge.edit.body")
                    }
                    field("Base branch", "baseBranch") {
                        TextField("main", text: $base).aceMonospace(AceTheme.Typography.code, relativeTo: .body)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("forge.edit.base")
                    }
                    field("Labels", "labels") {
                        TextField("One label per line", text: $labels, axis: .vertical).lineLimit(1...6).textInputAutocapitalization(.never)
                            .accessibilityIdentifier("forge.edit.labels")
                    }
                    field("Assignees", "assignees") {
                        TextField("One login per line", text: $assignees, axis: .vertical).lineLimit(1...6)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("forge.edit.assignees")
                    }
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("Edit pull request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if changes.isEmpty { dismiss() } else { discarding = true } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Saving") }
                    else {
                        Button("Save") { Task { await submit() } }
                            .disabled(changes.isEmpty || !valid)
                            .accessibilityIdentifier("forge.edit.save")
                    }
                }
            }
        }
        .interactiveDismissDisabled(!changes.isEmpty || saving)
        .confirmationDialog("Discard your edits?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .presentationDetents([.medium, .large])
    }

    /// Sends the edit and closes only once GitHub took it; otherwise the words stay, with why.
    private func submit() async {
        saving = true; problem = nil
        let outcome = await save(changes)
        saving = false
        if outcome.ok { dismiss() } else { problem = outcome.message }
    }

    /// A quiet heading over its field, shown only where this account may change it.
    @ViewBuilder private func field<Content: View>(_ heading: String, _ key: String, @ViewBuilder content: () -> Content) -> some View {
        if editable.contains(key) {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(heading).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.subtle)
                    .accessibilityAddTraits(.isHeader)
                content()
                Hairline()
            }
            .padding(.horizontal, AceDesign.Space.margin)
        }
    }
}

/// What a pull request edit sends: only the editable fields that changed, lists one per line.
enum ForgePullEdit {
    static func changes(from metadata: ForgeManage.Metadata, editable: Set<String>, title: String, body: String,
                        base: String, labels: String, assignees: String) -> [String: Any] {
        var changes: [String: Any] = [:]
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if editable.contains("title"), title != metadata.title { changes["title"] = title }
        if editable.contains("body"), body != metadata.body { changes["body"] = body }
        if editable.contains("baseBranch"), !base.isEmpty, base != metadata.baseBranch { changes["baseBranch"] = base }
        let labelList = list(labels), assigneeList = list(assignees)
        // Order isn't an edit: GitHub keeps labels and assignees as sets.
        if editable.contains("labels"), Set(labelList) != Set(metadata.labels) { changes["labels"] = labelList }
        if editable.contains("assignees"), Set(assigneeList) != Set(metadata.assignees) { changes["assignees"] = assigneeList }
        return changes
    }
    /// One per line, as the web's editor takes them (a label's name may hold a comma): each once,
    /// in the order typed.
    static func list(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
