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
/// when this phone may, otherwise how to add one there.
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
        List {
            if offersChat {
                Section { chatRow }.insetRowBackground()
            }
            switch compose.projectsState {
            case "failed":
                ContentUnavailableView {
                    Label("Couldn't read projects", systemImage: "wifi.exclamationmark")
                } description: { Text("Your computer didn't answer.") } actions: { Button("Try again", action: reload) }
                .listRowBackground(Color.clear)
            case "ready":
                let recent = matches.filter(\.recent)
                let rest = matches.filter { !$0.recent }
                if matches.isEmpty, !query.isEmpty {
                    ContentUnavailableView("No projects match", systemImage: "folder")
                        .listRowBackground(Color.clear)
                }
                if !recent.isEmpty {
                    Section { ForEach(recent) { row($0) } } header: { InsetHeader("Recent") }.insetRowBackground()
                }
                if !rest.isEmpty {
                    Section { ForEach(rest) { row($0) } } header: { InsetHeader(recent.isEmpty ? "Projects" : "Other projects") }
                        .insetRowBackground()
                }
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
            Section {
                if canAdd {
                    Button(action: addProject) { InsetRow("Add project", systemImage: "folder.badge.plus") }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("projects.add")
                }
            } footer: {
                if !canAdd { Text("To add a project, open ace on your computer and choose Add project.") }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Project").navigationBarTitleDisplayMode(.inline)
        .refreshable { reload() }
    }
    /// A chat with no project (ADR 0099).
    private var chatRow: some View {
        Button { choose(NewThreadDraft.chat) } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                Image(systemName: "bubble.left").foregroundStyle(AceTheme.Colours.mutedForeground)
                Text("No project").aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                Spacer(minLength: AceTheme.Spacing.none)
                if selected == NewThreadDraft.chat { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .padding(.vertical, AceTheme.Spacing.xs).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected == NewThreadDraft.chat ? .isSelected : [])
        .accessibilityIdentifier("project.chat")
    }
    private func row(_ project: ComposeProject) -> some View {
        Button { choose(project.id) } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(project.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                    Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: AceTheme.Spacing.none)
                if project.id == selected { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .padding(.vertical, AceTheme.Spacing.xs).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(project.id == selected ? .isSelected : [])
        .accessibilityIdentifier("project.\(project.id)")
    }
}

/// Register an existing folder on the computer as a project (`workspace.add`), found among its
/// recent folders or by search.
struct AddProjectView: View {
    let client: ClientModel
    let added: (String) -> Void
    @State private var query = ""
    @State private var adding: String?
    @State private var failure: String?
    private var folders: (query: String, state: String, folders: [ComposeFolder])? { client.compose.folders }
    var body: some View {
        List {
            if client.canOperate {
                Section {
                    NavigationLink { CreateProjectView(model: client, cloning: false, added: added) } label: { InsetRow("New project", systemImage: "folder.badge.plus") }
                    NavigationLink { CreateProjectView(model: client, cloning: true, added: added) } label: { InsetRow("Clone repository", systemImage: "arrow.down.doc") }
                }
                .insetRowBackground()
            }
            if let failure {
                Text(failure).foregroundStyle(AceTheme.StatusText.failed).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .listRowBackground(Color.clear)
            }
            switch folders?.state {
            case "ready":
                if folders?.folders.isEmpty == true { ContentUnavailableView.search(text: query).listRowBackground(Color.clear) }
                Section {
                    ForEach(folders?.folders ?? []) { folder in
                        Button { add(folder) } label: {
                            HStack(spacing: AceTheme.Spacing.md + AceTheme.Spacing.xxs) {
                                Image(systemName: folder.git ? "arrow.triangle.branch" : "folder").font(.system(size: 19))
                                    .foregroundStyle(AceTheme.Colours.foreground).frame(width: 24)
                                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                    Text(folder.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                    Text(folder.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                                }
                                Spacer(minLength: AceTheme.Spacing.none)
                                if adding == folder.path { ProgressView() } else if folder.project { InsetValue(text: "Added") }
                            }
                            .padding(.vertical, AceTheme.Spacing.xs).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(adding != nil || folder.project)
                        .accessibilityIdentifier("folder.\(folder.name)")
                    }
                }
                .insetRowBackground()
            case "forbidden":
                ContentUnavailableView("Add it on your computer", systemImage: "desktopcomputer",
                                       description: Text("This computer doesn't let this phone browse its folders. In ace on your computer, choose Add project."))
                    .listRowBackground(Color.clear)
            case "failed":
                ContentUnavailableView("Couldn't search folders", systemImage: "wifi.exclamationmark", description: Text("Check the connection and try again."))
                    .listRowBackground(Color.clear)
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search folders on your computer")
        .navigationTitle("Add project").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            client.composeAction(["kind": "folders", "query": query])
        }
    }
    private func add(_ folder: ComposeFolder) {
        let requestId = "add-" + UUID().uuidString.lowercased().prefix(24)
        adding = folder.path; failure = nil
        Task {
            guard await client.addProject(path: folder.path, requestId: requestId) else {
                adding = nil; failure = client.error ?? "Couldn't save the request on this phone."; client.error = nil
                return
            }
            for _ in 0..<150 {
                if let outcome = client.compose.added[requestId] {
                    adding = nil
                    if outcome.ok, let id = outcome.id { client.composeAction(["kind": "projects"]); added(id) }
                    else { failure = outcome.message }
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            adding = nil
            failure = "Saved on this phone. It's added once your computer answers."
        }
    }
}
