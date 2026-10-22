import SwiftUI

struct NativeProject: Decodable, Identifiable {
    let id: String
    let name: String
    let path: String
}
struct ProjectListReply: Decodable {
    struct Result: Decodable { let kind: String; let projects: [NativeProject]?; let next: String?; let code: String? }
    let result: Result
}

/// Settings › Projects: the machine's projects as quiet rows (name over its mono path), with
/// search, paging and one add path at the end.
struct ProjectsView: View {
    let model: ClientModel
    @State private var projects: [NativeProject] = []
    @State private var next: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var problem: String?
    @State private var query = ""
    @State private var adding = false
    private var matches: [NativeProject] {
        projects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        List {
            if model.connection != "ready" {
                InboxConnectionBanner(connection: model.connection, retry: model.retry)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if let problem, projects.isEmpty {
                EmptyState(icon: nil, title: "Couldn't read projects", line: problem, failed: true) {
                    Button("Try again") { Task { await read() } }
                }
                .accessibilityIdentifier("service.problem")
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if loading && projects.isEmpty {
                Section {
                    ForEach(0..<4, id: \.self) { index in
                        SettingsSkeletonRow()
                            .accessibilityElement(children: .ignore).accessibilityLabel("Loading projects")
                            .accessibilityHidden(index != 0)
                    }
                }
                .settingsRow()
            } else if loaded && projects.isEmpty {
                EmptyState(icon: .folder, title: "No projects yet",
                           line: model.canOperate ? "Add a folder from your computer to start." : nil)
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if !projects.isEmpty {
                Section {
                    if matches.isEmpty {
                        Text("No projects match").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    ForEach(matches) { project in
                        NavigationLink { ProjectDetailView(model: model, project: project) } label: { row(project) }
                            .accessibilityIdentifier("projects.row.\(project.id)")
                    }
                    if next != nil {
                        Button { Task { await read(more: true) } } label: { SettingsRow(title: "Show more projects") { EmptyView() } }
                            .buttonStyle(.plain).disabled(loading)
                    }
                    if let problem {
                        ServiceProblem(message: problem)
                        Button { Task { await read() } } label: { SettingsRow(title: "Try again") { EmptyView() } }
                            .buttonStyle(.plain)
                    }
                }
                .settingsRow()
            }
            if model.canOperate {
                Section {
                    Button { adding = true } label: {
                        SettingsRow(title: "Add project") { AceIcon(.plus, size: 16).foregroundStyle(AceTheme.Colours.subtleForeground) }
                    }
                    .buttonStyle(.plain)
                }
                .settingsRow()
            }
        }
        .settingsList()
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await read() } }.refreshable { await read() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                AddProjectView(client: model) { _ in adding = false; Task { await read() } }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { adding = false } } }
            }
        }
    }
    private func row(_ project: NativeProject) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Text(project.name).aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
            Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    private func read(more: Bool = false) async {
        guard !loading else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            var operation: [String: Any] = ["op": "workspace.list", "limit": 100]
            if more, let next { operation["after"] = next }
            let reply = try await model.service(["type": "projects.request", "operation": operation], as: ProjectListReply.self)
            guard reply.result.kind == "projects" else {
                throw ServiceFailure(message: reply.result.code == "forbidden" ? "This pairing doesn't include Projects access. Pair again with Projects enabled on your computer." : "Couldn't read projects: \(reply.result.code ?? "unavailable"). Retry when your machine is ready.")
            }
            loaded = true
            projects = (more ? projects : []) + (reply.result.projects ?? []); next = reply.result.next
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

/// One project: where it lives on the computer, then its files and the CLI sessions found there.
private struct ProjectDetailView: View {
    let model: ClientModel
    let project: NativeProject
    var body: some View {
        List {
            Section {
                Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground).textSelection(.enabled)
            } header: { SettingsHeader("Folder") }
            .settingsRow()
            Section {
                NavigationLink { FilesScreen(model: model, scope: .project(project.id), subtitle: project.name, mention: nil) } label: {
                    SettingsLinkLabel(title: "Files", icon: .folder)
                }
                NavigationLink { PastSessionsView(model: model, project: project) } label: {
                    SettingsLinkLabel(title: "Past CLI sessions", icon: .clockCounterClockwise)
                }
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
    }
}
