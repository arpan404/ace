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
        catch { return ForgeIssueChangeOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
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
        .sheet(isPresented: $editing) {
            ForgeIssueEditSheet(page: page) { edit in await apply(edit) }
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

    /// The edit's writes in order (text, then labels, then assignees), stopping at the first GitHub
    /// refuses so the sheet keeps what is left.
    private func apply(_ edit: ForgeIssueEdit) async -> ForgeIssueChangeOutcome {
        var last = ForgeIssueChangeOutcome(ok: true, message: "", uncertain: false)
        for input in edit.inputs(number: page.number, revision: page.revision ?? "", base: (page.title, page.body)) {
            last = await client.forgeIssueChange(project: project, repository: page.repository, input: input)
            if !last.ok { break }
        }
        await changed()
        return last
    }
}

/// The issue edit the sheet built: the text if it changed, and labels and assignees as what to add
/// and remove, as the protocol takes them.
struct ForgeIssueEdit: Equatable {
    var title: String?
    var body: String?
    var labels: (add: [String], remove: [String]) = ([], [])
    var assignees: (add: [String], remove: [String]) = ([], [])
    var isEmpty: Bool {
        title == nil && body == nil && labels.add.isEmpty && labels.remove.isEmpty && assignees.add.isEmpty && assignees.remove.isEmpty
    }
    static func == (a: ForgeIssueEdit, b: ForgeIssueEdit) -> Bool {
        a.title == b.title && a.body == b.body && a.labels.add == b.labels.add && a.labels.remove == b.labels.remove
            && a.assignees.add == b.assignees.add && a.assignees.remove == b.assignees.remove
    }

    /// What changed from the page: lists one per line, compared as sets, kept in the order typed.
    static func from(was: (title: String, body: String, labels: [String], assignees: [String]),
                     title: String, body: String, labels: String, assignees: String) -> ForgeIssueEdit {
        var edit = ForgeIssueEdit()
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title != was.title || body != was.body {
            edit.title = title
            edit.body = body
        }
        let labelList = ForgePullEdit.list(labels), assigneeList = ForgePullEdit.list(assignees)
        edit.labels = (labelList.filter { !was.labels.contains($0) }, was.labels.filter { !labelList.contains($0) })
        edit.assignees = (assigneeList.filter { !was.assignees.contains($0) }, was.assignees.filter { !assigneeList.contains($0) })
        return edit
    }

    func inputs(number: Int, revision: String, base: (title: String, body: String)) -> [[String: Any]] {
        var inputs: [[String: Any]] = []
        if let title, let body {
            inputs.append(["action": "edit", "number": number, "expectedUpdatedAt": revision, "title": title, "body": body,
                           "base": ["title": base.title, "body": base.body]])
        }
        if !labels.add.isEmpty || !labels.remove.isEmpty {
            inputs.append(["action": "labels", "number": number, "add": labels.add, "remove": labels.remove])
        }
        if !assignees.add.isEmpty || !assignees.remove.isEmpty {
            inputs.append(["action": "assignees", "number": number, "add": assignees.add, "remove": assignees.remove])
        }
        return inputs
    }
}

/// An issue's title, description, labels and assignees, sent as the writes that changed; the sheet
/// closes only once GitHub took them all.
struct ForgeIssueEditSheet: View {
    let page: ForgeIssuePage
    let save: (ForgeIssueEdit) async -> ForgeIssueChangeOutcome
    @State private var title: String
    @State private var text: String
    @State private var labels: String
    @State private var assignees: String
    @State private var saving = false
    @State private var problem: String?
    @State private var discarding = false
    @Environment(\.dismiss) private var dismiss

    init(page: ForgeIssuePage, save: @escaping (ForgeIssueEdit) async -> ForgeIssueChangeOutcome) {
        self.page = page
        self.save = save
        _title = State(initialValue: page.title)
        _text = State(initialValue: page.body)
        _labels = State(initialValue: page.labels.map(\.name).joined(separator: "\n"))
        _assignees = State(initialValue: page.assignees.joined(separator: "\n"))
    }

    private var edit: ForgeIssueEdit {
        .from(was: (page.title, page.body, page.labels.map(\.name), page.assignees),
              title: title, body: text, labels: labels, assignees: assignees)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                    if let problem { ForgeSheetProblem(text: problem) }
                    ForgeSheetField("Title") { TextField("Title", text: $title).accessibilityIdentifier("forge.issue.edit.title") }
                    ForgeSheetField("Description") {
                        TextField("Description", text: $text, axis: .vertical).lineLimit(4...12)
                            .accessibilityIdentifier("forge.issue.edit.body")
                    }
                    ForgeSheetField("Labels") {
                        TextField("One label per line", text: $labels, axis: .vertical).lineLimit(1...6)
                            .textInputAutocapitalization(.never).accessibilityIdentifier("forge.issue.edit.labels")
                    }
                    ForgeSheetField("Assignees") {
                        TextField("One login per line", text: $assignees, axis: .vertical).lineLimit(1...6)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("forge.issue.edit.assignees")
                    }
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("Edit issue").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if edit.isEmpty { dismiss() } else { discarding = true } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Saving") }
                    else {
                        Button("Save") { Task { await submit() } }
                            .disabled(edit.isEmpty || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("forge.issue.edit.save")
                    }
                }
            }
        }
        .interactiveDismissDisabled(!edit.isEmpty || saving)
        .confirmationDialog("Discard your edits?", isPresented: $discarding, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        saving = true; problem = nil
        let outcome = await save(edit)
        saving = false
        if outcome.ok { dismiss() } else { problem = outcome.message }
    }
}

/// A new issue on the project's repository: a title and a description, opened once GitHub has it.
struct ForgeNewIssueSheet: View {
    let client: ClientModel
    let project: String
    let opened: (Int) -> Void
    @State private var repository: ForgeRepository?
    @State private var title = ""
    @State private var text = ""
    @State private var saving = false
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
                    if let repository {
                        Text("Opens on \(repository.owner)/\(repository.name)")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                            .padding(.horizontal, AceDesign.Space.margin)
                    }
                }
                .padding(.vertical, AceDesign.Space.related)
            }
            .background(AceDesign.Surface.background)
            .navigationTitle("New issue").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView().accessibilityLabel("Opening") }
                    else {
                        Button("Open") { Task { await submit() } }
                            .disabled(repository == nil || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("forge.newissue.open")
                    }
                }
            }
            .task {
                do { repository = try await client.forgeNewPrContext(project: project).repository }
                catch { problem = "Couldn't find this project's repository. \(error.localizedDescription)" }
            }
        }
        .interactiveDismissDisabled(dirty || saving)
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        guard let repository else { return }
        saving = true; problem = nil
        let outcome = await client.forgeIssueChange(project: project, repository: repository, input: [
            "action": "create", "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "body": text,
        ])
        saving = false
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
