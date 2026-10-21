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
                ContentUnavailableView {
                    Label("Couldn't read projects", systemImage: "wifi.exclamationmark")
                } description: { Text("Your computer didn't answer.") } actions: { Button("Try again", action: reload) }
            case "ready":
                let recent = matches.filter(\.recent)
                let rest = matches.filter { !$0.recent }
                if matches.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "No projects yet" : "No projects match", systemImage: "folder",
                                           description: Text(query.isEmpty ? "Add a folder from your computer to start." : ""))
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
                    Button(action: addProject) { SettingsRow(title: "Add a folder from your computer") { Image(systemName: "plus").foregroundStyle(AceTheme.Colours.subtleForeground) } }
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
                if project.id == selected { Image(systemName: "checkmark").font(.body.weight(.medium)).foregroundStyle(AceTheme.Colours.foreground) }
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
                    NavigationLink { CreateProjectView(model: client, cloning: false, added: added) } label: { Label("New project", systemImage: "folder.badge.plus") }
                    NavigationLink { CreateProjectView(model: client, cloning: true, added: added) } label: { Label("Clone repository", systemImage: "arrow.down.doc") }
                }
            }
            if let failure { Text(failure).foregroundStyle(AceTheme.StatusText.failed).aceFont(AceTheme.Typography.caption, relativeTo: .footnote) }
            switch folders?.state {
            case "ready":
                if folders?.folders.isEmpty == true { ContentUnavailableView.search(text: query) }
                ForEach(folders?.folders ?? []) { folder in
                    Button { add(folder) } label: {
                        HStack(spacing: AceTheme.Spacing.md) {
                            Image(systemName: folder.git ? "arrow.triangle.branch" : "folder").foregroundStyle(AceTheme.Colours.decoration)
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
                ContentUnavailableView("Add it on your computer", systemImage: "desktopcomputer",
                                       description: Text("This computer doesn't let this phone browse its folders. In ace on your computer, choose Add project."))
            case "failed":
                ContentUnavailableView("Couldn't search folders", systemImage: "wifi.exclamationmark", description: Text("Check the connection and try again."))
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
