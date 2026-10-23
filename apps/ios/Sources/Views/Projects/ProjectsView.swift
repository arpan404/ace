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
    private static let firstPage: [String: Any] = ["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]]

    /// Opens on the last projects this phone saw, read again behind them.
    init(model: ClientModel) {
        self.model = model
        let kept = model.kept(Self.firstPage, as: ProjectListReply.self)?.result
        _projects = State(initialValue: kept?.projects ?? [])
        _next = State(initialValue: kept?.next)
        _loaded = State(initialValue: kept != nil)
    }
    var body: some View {
        List {
            if model.connection != "ready" { InboxConnectionBanner(connection: model.connection, retry: model.retry).listRowBackground(Color.clear) }
            Section {
                ForEach(projects.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query) }) { project in
                    NavigationLink { ProjectDetailView(model: model, project: project) } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(project.name).aceFont(InsetStyle.label, relativeTo: .body)
                            Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                        }.padding(.vertical, AceTheme.Spacing.xs)
                    }.accessibilityIdentifier("projects.row.\(project.id)")
                }
                if next != nil { Button("Show more projects") { Task { await read(more: true) } }.disabled(loading) }
                if problem != nil {
                    ServiceProblem(message: problem)
                    Button("Retry") { Task { await read() } }
                }
            }
            .insetRowBackground()
            Group {
                if loading, !loaded { HStack { Spacer(); ProgressView().accessibilityLabel("Loading projects"); Spacer() } }
                if loaded && !loading && projects.isEmpty && problem == nil { ContentUnavailableView("No projects", systemImage: "folder") }
            }
            .listRowBackground(Color.clear)
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "Search projects")
        .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canOperate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add project")
                }
            }
        }
        .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(Self.firstPage)]) { if model.connection == "ready" { await read() } }
        .refreshable { await read() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                AddProjectView(client: model) { _ in adding = false; Task { await read() } }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { adding = false } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                        }
                    }
            }
            .tint(AceTheme.Colours.foreground)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
    private func read(more: Bool = false) async {
        guard !loading else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            var operation: [String: Any] = ["op": "workspace.list", "limit": 100]
            if more, let next { operation["after"] = next }
            let request: [String: Any] = ["type": "projects.request", "operation": operation]
            let reply = try await model.read(request, as: ProjectListReply.self)
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
            Section {
                Text(project.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).textSelection(.enabled)
            }
            .insetRowBackground()
            Section {
                NavigationLink { FilesScreen(model: model, scope: .project(project.id), subtitle: project.name, mention: nil) } label: { InsetRow("Files", systemImage: "folder") }
                NavigationLink { PastSessionsView(model: model, project: project) } label: { InsetRow("Past CLI sessions", systemImage: "clock.arrow.circlepath") }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle(project.name).navigationBarTitleDisplayMode(.inline)
    }
}
