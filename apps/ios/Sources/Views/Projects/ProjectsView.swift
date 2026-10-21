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

struct ProjectsView: View {
    let model: ClientModel
    @State private var projects: [NativeProject] = []
    @State private var next: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var problem: String?
    @State private var query = ""
    @State private var adding = false
    var body: some View {
        List {
            if model.connection != "ready" { InboxConnectionBanner(connection: model.connection, retry: model.retry) }
            ForEach(projects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }) { project in
                NavigationLink { ProjectDetailView(model: model, project: project) } label: {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        Text(project.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                        Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
                    }.padding(.vertical, AceTheme.Spacing.xs)
                }.accessibilityIdentifier("projects.row.\(project.id)")
            }
            if next != nil { Button("Show more projects") { Task { await read(more: true) } }.disabled(loading) }
            if loading { ProgressView().accessibilityLabel("Loading projects") }
            ServiceProblem(message: problem)
            if problem != nil { Button("Retry") { Task { await read() } } }
            if loaded && !loading && projects.isEmpty && problem == nil { ContentUnavailableView("No projects", systemImage: "folder") }
            if model.canOperate { Button("Add project", systemImage: "folder.badge.plus") { adding = true } }
        }
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

private struct ProjectDetailView: View {
    let model: ClientModel
    let project: NativeProject
    var body: some View {
        List {
            Section { Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).textSelection(.enabled) }
            NavigationLink { ThreadFilesSheet(model: model, scope: .project(project.id), mention: nil) } label: { Label("Files", systemImage: "folder") }
            NavigationLink { PastSessionsView(model: model, project: project) } label: { Label("Past CLI sessions", systemImage: "clock.arrow.circlepath") }
        }
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
    }
}
