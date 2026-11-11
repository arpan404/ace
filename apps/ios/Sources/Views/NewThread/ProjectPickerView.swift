import SwiftUI

/// New thread's project picker as its own full sheet: X leaves the choice as it was, Add project
/// pushes inside it, and choosing or adding a project closes it.
struct ProjectPickerSheet: View {
    let client: ClientModel
    let selected: String?
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        NavigationStack {
            ProjectPickerView(compose: client.compose, selected: selected, canAdd: client.canOperate,
                              reload: { client.composeAction(["kind": "projects"]) }, addProject: { adding = true }) { id in
                choose(id); dismiss()
            }
            .navigationDestination(isPresented: $adding) {
                AddProjectView(client: client) { id in choose(id); dismiss() }
            }
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("projects.close")
                }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
}

/// The machine's projects, recent ones first, with search; adding a folder from the computer
/// when this phone may, otherwise how to add one there. Quiet sections over hairlines, the
/// chosen one marked, and Add project a row that carries the caret of the page it opens.
struct ProjectPickerView: View {
    @Bindable var compose: ComposeModel
    let selected: String?
    let canAdd: Bool
    let reload: () -> Void
    let addProject: () -> Void
    let choose: (String) -> Void
    @State private var query = ""
    private var matches: [ComposeProject] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return compose.projects }
        return compose.projects.filter { $0.name.localizedCaseInsensitiveContains(needle) || $0.path.localizedCaseInsensitiveContains(needle) }
    }
    /// "No project" leads the list unless a search leaves it out.
    private var offersChat: Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || "No project chat".localizedCaseInsensitiveContains(needle)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if offersChat { chatRow }
                projects
                addProjectSection
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Project").navigationBarTitleDisplayMode(.inline)
        .refreshable { reload() }
    }

    /// A chat with no project (ADR 0099).
    private var chatRow: some View {
        QuietSection {
            Button { choose(NewThreadDraft.chat) } label: {
                QuietSectionRow {
                    QuietRowText(title: "No project")
                    if selected == NewThreadDraft.chat {
                        AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                            .foregroundStyle(AceDesign.Ink.primary)
                    }
                }
            }
            .buttonStyle(.row)
            .accessibilityAddTraits(selected == NewThreadDraft.chat ? .isSelected : [])
            .accessibilityIdentifier("project.chat")
        }
    }

    @ViewBuilder private var projects: some View {
        switch compose.projectsState {
        case "failed":
            QuietProblemRow(title: "Couldn't read projects.", detail: "Your computer didn't answer.",
                            action: "Try again", identifier: "projects.retry", run: reload)
        case "ready":
            let recent = matches.filter(\.recent)
            let rest = matches.filter { !$0.recent }
            if matches.isEmpty, !query.isEmpty {
                quietLine("No projects match “\(query)”.")
            }
            if !recent.isEmpty {
                QuietSection("Recent") {
                    ForEach(recent) { project in row(project) }
                }
            }
            if !rest.isEmpty {
                QuietSection(recent.isEmpty ? "Projects" : "Other projects") {
                    ForEach(rest) { project in row(project) }
                }
            }
        default:
            SkeletonRows(count: 3, label: "Loading")
        }
    }

    /// One project: its name, its folder in mono, and a check when it's the one chosen.
    private func row(_ project: ComposeProject) -> some View {
        Button { choose(project.id) } label: {
            QuietSectionRow {
                QuietPathRow(name: project.name, path: project.path)
                if project.id == selected {
                    AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                        .foregroundStyle(AceDesign.Ink.primary)
                }
            }
        }
        .buttonStyle(.row)
        .accessibilityAddTraits(project.id == selected ? .isSelected : [])
        .accessibilityIdentifier("project.\(project.id)")
    }

    @ViewBuilder private var addProjectSection: some View {
        QuietSection {
            if canAdd {
                Button(action: addProject) {
                    QuietSectionRow {
                        QuietRowText(title: "Add project")
                        RowCaret()
                    }
                }
                .buttonStyle(.row)
                .accessibilityIdentifier("projects.add")
            } else {
                QuietSectionRow {
                    QuietRowText(title: "To add a project, open ace on your computer and choose Add project.",
                                 tone: AceDesign.Ink.muted)
                }
            }
        }
    }
}

/// Register an existing folder on the computer as a project (`workspace.add`), found among its
/// recent folders or by search. The folders are quiet rows with their path in mono; a folder the
/// machine refuses can be allowed, and a search that failed can be asked again.
struct AddProjectView: View {
    let client: ClientModel
    let added: (String) -> Void
    @State private var query = ""
    @State private var adding: String?
    @State private var failure: String?
    /// The folder refused for being outside the machine's project folders, to allow and add.
    @State private var allowable: ComposeFolder?
    private var folders: (query: String, state: String, folders: [ComposeFolder])? { client.compose.folders }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if client.canOperate {
                    QuietSection {
                        NavigationLink { CreateProjectView(model: client, cloning: false, added: added) } label: {
                            QuietSectionRow {
                                QuietRowText(title: "New project")
                                RowCaret()
                            }
                        }
                        .accessibilityIdentifier("projects.new")
                        NavigationLink { CreateProjectView(model: client, cloning: true, added: added) } label: {
                            QuietSectionRow {
                                QuietRowText(title: "Clone repository")
                                RowCaret()
                            }
                        }
                        .accessibilityIdentifier("projects.clone")
                    }
                }
                if let failure {
                    QuietProblemRow(title: failure,
                                    action: allowable != nil && client.canOperate ? "Allow this folder" : nil,
                                    identifier: "folder.allow") {
                        if let allowable { Task { await allow(allowable) } }
                    }
                    .transition(.opacity)
                }
                folderList
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            .smoothChange(failure)
        }
        .background(AceDesign.Surface.background)
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search folders on your computer")
        .navigationTitle("Add project").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            client.composeAction(["kind": "folders", "query": query])
        }
    }

    @ViewBuilder private var folderList: some View {
        switch folders?.state {
        case "ready":
            let rows = folders?.folders ?? []
            if rows.isEmpty {
                quietLine(query.isEmpty ? "No folders to add." : "No folders match “\(query)”.")
            } else {
                QuietSection("Folders on your computer") {
                    ForEach(rows) { folder in
                        Button { add(folder) } label: {
                            QuietSectionRow {
                                QuietPathRow(name: folder.name, path: folder.path)
                                if adding == folder.path {
                                    ProgressView().accessibilityLabel("Adding \(folder.name)")
                                } else if folder.project {
                                    Text("Added").aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                                        .foregroundStyle(AceDesign.Ink.subtle)
                                }
                            }
                        }
                        .buttonStyle(.row)
                        .disabled(adding != nil || folder.project)
                        .accessibilityIdentifier("folder.\(folder.name)")
                    }
                }
            }
        case "forbidden":
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text("Add it on your computer").aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceDesign.Ink.primary)
                Text("This computer doesn't let this phone browse its folders. In ace on your computer, choose Add project.")
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .frame(maxWidth: .infinity, alignment: .leading)
        case "failed":
            QuietProblemRow(title: "Couldn't search folders.", detail: "Check the connection and try again.",
                            action: "Try again", identifier: "folders.retry") {
                client.composeAction(["kind": "folders", "query": query])
            }
        default:
            SkeletonRows(count: 3, label: "Loading")
        }
    }

    /// Allow the folder on the machine, then add it, as the web's Allow this folder.
    private func allow(_ folder: ComposeFolder) async {
        adding = folder.path
        let outcome = await client.projectWrite(["op": "allowFolder", "path": folder.path, "create": false])
        adding = nil
        if outcome.ok { add(folder) } else { failure = outcome.message ?? "Couldn't allow this folder. Check that it exists, then try again." }
    }
    private func add(_ folder: ComposeFolder) {
        let requestId = "add-" + UUID().uuidString.lowercased().prefix(24)
        adding = folder.path; failure = nil; allowable = nil
        Task {
            guard await client.addProject(path: folder.path, requestId: requestId) else {
                adding = nil; failure = client.error ?? "Couldn't save the request on this phone."; client.error = nil
                return
            }
            for _ in 0..<150 {
                if let outcome = client.compose.added[requestId] {
                    adding = nil
                    if outcome.ok, let id = outcome.id { client.composeAction(["kind": "projects"]); added(id) }
                    else { failure = outcome.message; allowable = outcome.canAllow ? folder : nil }
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            adding = nil
            failure = "Saved on this phone. It's added once your computer answers."
        }
    }
}

/// A page's one quiet line: what was searched and found nothing, or why there's no list.
@MainActor private func quietLine(_ text: String) -> some View {
    Text(text).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .foregroundStyle(AceDesign.Ink.muted)
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
}

/// A project or a folder as both pickers list it: its name in the row role over its folder in mono.
private struct QuietPathRow: View {
    let name: String
    let path: String
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(name).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
            Text(verbatim: path).aceMonospace(AceDesign.TextRole.branch, relativeTo: .caption)
                .foregroundStyle(AceDesign.Ink.muted).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
