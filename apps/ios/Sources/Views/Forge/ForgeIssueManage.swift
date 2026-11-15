import SwiftUI

/// What an issue write came back with: whether GitHub took it, its words if not, and the issue a
/// create opened.
struct ForgeIssueChangeOutcome: Decodable, Sendable, Equatable {
    let ok: Bool
    let message: String
    let uncertain: Bool
    var opened: Int?
}

extension ClientModel {
    /// One issue write besides a comment (`forge.issue.change`): create, edit, state, labels,
    /// assignees or milestone, journalled so a lost answer is checked, never sent twice.
    func forgeIssueChange(project: String, repository: ForgeRepository, input: [String: Any]) async -> ForgeIssueChangeOutcome {
        guard canOperate else {
            return ForgeIssueChangeOutcome(ok: false, message: "View only. Pair this phone with View and act to change issues.", uncertain: false)
        }
        let request: [String: Any] = ["type": "forge.issue.change", "project": project, "repository": repository.json, "input": input]
        do { return try await service(request, as: ForgeIssueChangeOutcome.self) }
        // Sent, then no answer read (a timeout, a dropped link, a reply not understood): it may have
        // landed, so it is unconfirmed and isn't sent again from the sheet.
        catch { return ForgeIssueChangeOutcome(ok: false, message: "\(error.localizedDescription) It may have gone through.", uncertain: true) }
    }
}

/// An issue's own changes, as words under its conversation: close it (completed or not planned) or
/// reopen it, and edit its title, description, labels and assignees.
struct ForgeIssueManageSection: View {
    let client: ClientModel
    let project: String
    let page: ForgeIssuePage
    let changed: () async -> Void
    @State private var busy = false
    @State private var problem: String?
    @State private var editing = false

    private var open: Bool { page.state.word == "Open" }

    var body: some View {
        QuietSection("Manage") {
            QuietSectionRow {
                if open {
                    Button("Close as completed") { setState("closed", reason: "completed") }
                        .buttonStyle(.textAction())
                        .accessibilityIdentifier("forge.issue.close")
                    Button("Close as not planned") { setState("closed", reason: "not_planned") }
                        .buttonStyle(.textAction())
                        .accessibilityIdentifier("forge.issue.notPlanned")
                } else {
                    Button("Reopen") { setState("open", reason: nil) }
                        .buttonStyle(.textAction(.prominent))
                        .accessibilityIdentifier("forge.issue.reopen")
                }
            }
            .disabled(busy || page.revision == nil)
            Button { editing = true } label: {
                QuietSectionRow { QuietRowText(title: "Edit title, description and labels"); RowCaret() }
            }
            .buttonStyle(.row)
            .disabled(busy || page.revision == nil)
            .accessibilityIdentifier("forge.issue.edit")
            if let problem {
                QuietSectionRow {
                    Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .sheet(isPresented: $editing, onDismiss: { Task { await changed() } }) {
            ForgeIssueEditSheet(page: page) { input in
                await client.forgeIssueChange(project: project, repository: page.repository, input: input)
            }
        }
    }

    private func setState(_ state: String, reason: String?) {
        guard let revision = page.revision else { return }
        var input: [String: Any] = ["action": "state", "number": page.number, "expectedUpdatedAt": revision, "state": state]
        if let reason { input["reason"] = reason }
        busy = true; problem = nil
        Task {
            let outcome = await client.forgeIssueChange(project: project, repository: page.repository, input: input)
            busy = false
            problem = outcome.ok ? nil : outcome.message
            await changed()
        }
    }
}

/// What an issue looked like when its edit sheet opened: every change is measured from it, and a
/// retry after a partial save never measures again from a page someone else has changed since.
struct ForgeIssueBaseline: Equatable {
    let title: String
    let body: String
    let labels: [String]
    let assignees: [String]
    let revision: String
    /// The body arrived whole: only then can the text be edited from it.
    let bodyComplete: Bool
}

/// The issue edit the sheet built: the text if it changed, and labels and assignees as what to add
/// and remove, as the protocol takes them.
struct ForgeIssueEdit: Equatable {
    var title: String?
    var body: String?
    var labels = ForgeIssueEdit.Change()
    var assignees = ForgeIssueEdit.Change()
    struct Change: Equatable { var add: [String] = []; var remove: [String] = []; var isEmpty: Bool { add.isEmpty && remove.isEmpty } }
    var isEmpty: Bool { title == nil && body == nil && labels.isEmpty && assignees.isEmpty }

    /// What changed from `was`: lists one per line, compared as sets and without regard to case
    /// (GitHub matches names so), kept in the order and spelling typed.
    static func from(was: ForgeIssueBaseline, title: String, body: String, labels: String, assignees: String) -> ForgeIssueEdit {
        var edit = ForgeIssueEdit()
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title != was.title || (was.bodyComplete && body != was.body) {
            edit.title = title
            edit.body = was.bodyComplete ? body : was.body
        }
        edit.labels = change(from: was.labels, to: ForgePullEdit.list(labels))
        edit.assignees = change(from: was.assignees, to: ForgePullEdit.list(assignees))
        return edit
    }
    static func change(from old: [String], to new: [String]) -> Change {
        let had = Set(old.map { $0.lowercased() }), has = Set(new.map { $0.lowercased() })
        return Change(add: new.filter { !had.contains($0.lowercased()) }, remove: old.filter { !has.contains($0.lowercased()) })
    }

    /// The writes, each with the name the sheet tracks it by, in the order they go.
    func inputs(number: Int, was: ForgeIssueBaseline) -> [(step: String, input: [String: Any])] {
        var inputs: [(String, [String: Any])] = []
        if let title, let body {
            inputs.append(("text", ["action": "edit", "number": number, "expectedUpdatedAt": was.revision, "title": title, "body": body,
                                    "base": ["title": was.title, "body": was.body]]))
        }
        if !labels.isEmpty { inputs.append(("labels", ["action": "labels", "number": number, "add": labels.add, "remove": labels.remove])) }
        if !assignees.isEmpty {
            inputs.append(("assignees", ["action": "assignees", "number": number, "add": assignees.add, "remove": assignees.remove]))
        }
        return inputs
    }
}

/// An issue's title, description, labels and assignees, sent as the writes that changed; the sheet
/// closes only once GitHub took them all. A write that landed isn't sent again on Save.
struct ForgeIssueEditSheet: View {
    let number: Int
    let send: ([String: Any]) async -> ForgeIssueChangeOutcome
    @State private var was: ForgeIssueBaseline
    @State private var title: String
    @State private var text: String
    @State private var labels: String
    @State private var assignees: String
    /// The steps GitHub already took (text, labels, assignees).
    @State private var done: Set<String> = []
    @State private var saving = false
    @State private var unconfirmed = false
    @State private var problem: String?
    @State private var discarding = false
    @Environment(\.dismiss) private var dismiss

    init(page: ForgeIssuePage, send: @escaping ([String: Any]) async -> ForgeIssueChangeOutcome) {
        number = page.number
        self.send = send
        _was = State(initialValue: ForgeIssueBaseline(title: page.title, body: page.body, labels: page.labels.map(\.name),
                                                      assignees: page.assignees, revision: page.revision ?? "",
                                                      bodyComplete: page.bodyComplete ?? false))
        _title = State(initialValue: page.title)
        _text = State(initialValue: page.body)
        _labels = State(initialValue: page.labels.map(\.name).joined(separator: "\n"))
        _assignees = State(initialValue: page.assignees.joined(separator: "\n"))
    }

    private var edit: ForgeIssueEdit { .from(was: was, title: title, body: text, labels: labels, assignees: assignees) }
    private var pending: [(step: String, input: [String: Any])] { edit.inputs(number: number, was: was).filter { !done.contains($0.step) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem { ForgeSheetProblem(text: problem) }
                    ForgeSheetField("Title") {
                        TextField("Title", text: $title).disabled(done.contains("text")).accessibilityIdentifier("forge.issue.edit.title")
                    }
                    ForgeSheetField("Description") {
                        if was.bodyComplete {
                            TextField("Description", text: $text, axis: .vertical).lineLimit(4...12)
                                .disabled(done.contains("text"))
                                .accessibilityIdentifier("forge.issue.edit.body")
                        } else {
                            Text("This description is too long to edit on the phone. Edit it on GitHub.")
                                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                        }
                    }
                    ForgeSheetField("Labels") {
                        TextField("One label per line", text: $labels, axis: .vertical).lineLimit(1...6)
                            .textInputAutocapitalization(.never).disabled(done.contains("labels"))
                            .accessibilityIdentifier("forge.issue.edit.labels")
                    }
                    ForgeSheetField("Assignees") {
                        TextField("One login per line", text: $assignees, axis: .vertical).lineLimit(1...6)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .disabled(done.contains("assignees"))
                            .accessibilityIdentifier("forge.issue.edit.assignees")
                    }
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("Edit issue").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if pending.isEmpty { dismiss() } else { discarding = true } }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Saving") }
                    else {
                        Button("Save") { Task { await submit() } }
                            .disabled(pending.isEmpty || unconfirmed || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("forge.issue.edit.save")
                    }
                }
            }
        }
        .interactiveDismissDisabled(!pending.isEmpty || saving)
        .confirmationDialog("Discard your edits?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        saving = true; problem = nil
        defer { saving = false }
        for step in pending {
            let outcome = await send(step.input)
            guard outcome.ok else {
                // A lost answer may have landed: it isn't sent again from here.
                unconfirmed = outcome.uncertain
                problem = outcome.uncertain ? "GitHub didn't confirm the change. Close this and check the issue before trying again." : outcome.message
                return
            }
            done.insert(step.step)
        }
        dismiss()
    }
}

/// Where a new issue opens: the list's own machine and project, and the repository it named.
struct ForgeNewIssueTarget: Identifiable {
    let scope: ForgeListScope
    let repository: ForgeRepository
    var id: String { "\(scope.machineId)/\(scope.project)/\(repository.owner)/\(repository.name)" }
}

/// A new issue on the repository the project's issues open on: a title and a description, opened
/// once GitHub has it. One whose answer was lost is never sent again from here.
struct ForgeNewIssueSheet: View {
    let client: ClientModel
    let project: String
    let repository: ForgeRepository
    let opened: (Int) -> Void
    @State private var title = ""
    @State private var text = ""
    @State private var saving = false
    @State private var unconfirmed = false
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    private var dirty: Bool { !title.isEmpty || !text.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem { ForgeSheetProblem(text: problem) }
                    ForgeSheetField("Title") { TextField("What's wrong or wanted", text: $title).accessibilityIdentifier("forge.newissue.title") }
                    ForgeSheetField("Description") {
                        TextField("Steps, what you expected, what happened", text: $text, axis: .vertical).lineLimit(4...12)
                            .accessibilityIdentifier("forge.newissue.body")
                    }
                    Text("Opens on \(repository.owner)/\(repository.name)")
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                        .padding(.horizontal, AceDesign.Space.margin)
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("New issue").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(unconfirmed ? "Done" : "Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Opening") }
                    else {
                        Button("Open") { Task { await submit() } }
                            .disabled(unconfirmed || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("forge.newissue.open")
                    }
                }
            }
        }
        .interactiveDismissDisabled((dirty && !unconfirmed) || saving)
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        saving = true; problem = nil
        defer { saving = false }
        let outcome = await client.forgeIssueChange(project: project, repository: repository, input: [
            "action": "create", "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "body": text,
        ])
        if outcome.uncertain {
            // It may have been opened: a second Open could make a duplicate.
            unconfirmed = true
            problem = "GitHub didn't confirm the issue. It may have opened: check the Issues list before opening it again."
            return
        }
        guard outcome.ok, let number = outcome.opened else { problem = outcome.ok ? "Opened, but GitHub didn't say its number." : outcome.message; return }
        dismiss()
        opened(number)
    }
}

/// A quiet heading over a sheet's field and the hairline under it.
struct ForgeSheetField<Content: View>: View {
    let heading: String
    @ViewBuilder let content: () -> Content
    init(_ heading: String, @ViewBuilder content: @escaping () -> Content) {
        self.heading = heading
        self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(heading).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.subtle)
                .accessibilityAddTraits(.isHeader)
            content()
            Hairline()
        }
        .padding(.horizontal, AceDesign.Space.margin)
    }
}

/// A sheet's failure: its sentence in the failed colour, above the fields it keeps.
struct ForgeSheetProblem: View {
    let text: String
    var body: some View {
        Text(text).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
            .foregroundStyle(AceTheme.StatusText.failed).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, AceDesign.Space.margin)
            .accessibilityIdentifier("forge.sheet.problem")
    }
}
