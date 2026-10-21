import SwiftUI

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
    var body: some View {
        List {
            switch compose.projectsState {
            case "failed":
                EmptyState(icon: nil, title: "Couldn't read projects", line: "Your computer didn't answer. Try again in a moment.", failed: true) {
                    Button("Try again", action: reload)
                }
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            case "ready":
                let recent = matches.filter(\.recent)
                let rest = matches.filter { !$0.recent }
                if matches.isEmpty {
                    EmptyState(icon: .folder, title: query.isEmpty ? "No projects yet" : "No projects match",
                               line: query.isEmpty ? "Add a folder from your computer to start." : nil)
                        .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if !recent.isEmpty { Section { ForEach(recent) { row($0) } } header: { SettingsHeader("Recent") }.settingsRow() }
                if !rest.isEmpty {
                    Section { ForEach(rest) { row($0) } } header: { SettingsHeader(recent.isEmpty ? "Projects" : "Other projects") }.settingsRow()
                }
            default:
                Section { ForEach(0..<4, id: \.self) { _ in ProjectSkeletonRow() } }.settingsRow()
            }
            Section {
                if canAdd {
                    Button(action: addProject) { SettingsRow(title: "Add a folder from your computer") { AceIcon(.plus, size: 16).foregroundStyle(AceTheme.Colours.subtleForeground) } }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("projects.add")
                } else {
                    Text("To add a project, open ace on your computer and choose Add project.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
            .settingsRow()
        }
        .settingsList()
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Project").navigationBarTitleDisplayMode(.inline)
        .refreshable { reload() }
    }
    private func row(_ project: ComposeProject) -> some View {
        Button { choose(project.id) } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(project.name).aceFont(SettingsStyle.label, relativeTo: .body).fontWeight(project.id == selected ? .medium : .regular)
                        .foregroundStyle(AceTheme.Colours.foreground)
                    Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: AceTheme.Spacing.none)
                if project.id == selected { AceIcon(.check, size: 16).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(project.id == selected ? .isSelected : [])
        .accessibilityIdentifier("project.\(project.id)")
    }
}

/// A project row while the list loads: the name and path as skeleton bars.
private struct ProjectSkeletonRow: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Capsule().fill(AceTheme.Colours.fill).frame(width: 120, height: 12)
            Capsule().fill(AceTheme.Colours.fill).frame(width: 200, height: 10)
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityHidden(true)
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
                    NavigationLink { CreateProjectView(model: client, cloning: false, added: added) } label: { Label("New project", ace: .folderPlus) }
                    NavigationLink { CreateProjectView(model: client, cloning: true, added: added) } label: { Label("Clone repository", ace: .fileArrowDown) }
                }
            }
            if let failure { Text(failure).foregroundStyle(AceTheme.StatusText.failed).aceFont(AceTheme.Typography.caption, relativeTo: .footnote) }
            switch folders?.state {
            case "ready":
                if folders?.folders.isEmpty == true { ContentUnavailableView.search(text: query) }
                ForEach(folders?.folders ?? []) { folder in
                    Button { add(folder) } label: {
                        HStack(spacing: AceTheme.Spacing.md) {
                            AceIcon(folder.git ? .gitBranch : .folder, size: 16).foregroundStyle(AceTheme.Colours.faintForeground)
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                Text(folder.name).aceFont(AceTheme.Typography.body, relativeTo: .body)
                                Text(folder.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
                            }
                            Spacer(minLength: AceTheme.Spacing.none)
                            if adding == folder.path { ProgressView() } else if folder.project { Text("Added").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                        }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(adding != nil || folder.project)
                    .accessibilityIdentifier("folder.\(folder.name)")
                }
            case "forbidden":
                EmptyState(icon: .desktop, title: "Add it on your computer",
                           line: "This computer doesn't let this phone browse its folders. In ace on your computer, choose Add project.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowSeparator(.hidden)
            case "failed":
                EmptyState(icon: nil, title: "Couldn't search folders", line: "Check the connection and try again.", failed: true)
                    .padding(.top, AceTheme.Spacing.xxxl).listRowSeparator(.hidden)
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            }
        }
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
