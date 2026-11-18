import SwiftUI

struct ProjectListReply: Decodable {
    struct Result: Decodable {
        let kind: String
        /// The machine's projects, without chats' hidden ones.
        let projects: [NativeProject]?
        let next: String?
        let code: String?
        private enum CodingKeys: String, CodingKey { case kind, projects, next, code }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(String.self, forKey: .kind)
            projects = try values.decodeIfPresent([NativeProject].self, forKey: .projects)?.filter { $0.kind != "chat" }
            next = try values.decodeIfPresent(String.self, forKey: .next)
            code = try values.decodeIfPresent(String.self, forKey: .code)
        }
    }
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
    static let firstPage: [String: Any] = ["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]]

    /// Opens on the last projects this phone saw, read again behind them.
    init(model: ClientModel) {
        self.model = model
        let kept = model.kept(Self.firstPage, as: ProjectListReply.self)?.result
        _projects = State(initialValue: kept?.projects ?? [])
        _next = State(initialValue: kept?.next)
        _loaded = State(initialValue: kept != nil)
    }
    private var listing: ProjectListing { ProjectListing.of(projects, next: next, loaded: loaded, reading: loading, query: query) }

    var body: some View {
        List {
            if model.connection != "ready" {
                Section { InboxConnectionBanner(connection: model.connection, retry: model.retry) }
                    .listRowBackground(Color.clear)
            }
            if let problem {
                Section { ProblemRow("Couldn't read projects.", detail: problem, id: "projects.problem") { Task { await read() } } }
            }
            switch listing {
            case .unread:
                EmptyView()
            case .reading:
                Section { SkeletonRows(count: 4, label: "Loading projects").listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
            case .empty:
                if problem == nil {
                    Section {
                        EmptyState(systemImage: "folder", title: "No projects") {
                            if model.canOperate { Button("Add project") { adding = true }.accessibilityIdentifier("projects.empty.add") }
                        }
                        .padding(.vertical, AceDesign.Space.group)
                    }
                    .listRowBackground(Color.clear)
                }
            case .rows(let ids, let more):
                Section {
                    ForEach(projects.filter { ids.contains($0.id) }) { project in
                        NavigationLink { ProjectDetailView(model: model, project: project) } label: { ProjectRowLabel(project: project) }
                            .accessibilityIdentifier("projects.row.\(project.id)")
                    }
                    if more { moreButton }
                }
                .insetRowBackground()
            case .noMatch(let more):
                Section {
                    EmptyState.search(query)
                    if more { moreButton.padding(.horizontal, AceDesign.Space.margin) }
                }
                .listRowBackground(Color.clear)
            }
            if query.isEmpty {
                Section {
                    NavigationLink { ProjectFoldersView(model: model) } label: {
                        InsetRow("Project folders", systemImage: nil, subtitle: "Where ace may open projects")
                    }
                    .accessibilityIdentifier("projects.folders")
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .searchBarEdge()
        .smoothChange(projects.map(\.id))
        .smoothChange(problem)
        .searchable(text: $query, prompt: "Search projects")
        .nativeTitle("Projects")
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
            .tint(AceDesign.Ink.action)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
    /// The next page, offered while searching too: a search only filters the pages read so far.
    private var moreButton: some View {
        Button(query.isEmpty ? "Show more projects" : "Search more projects") { Task { await read(more: true) } }
            .buttonStyle(.rowAction).disabled(loading)
            .accessibilityIdentifier("projects.more")
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
                throw ServiceFailure(message: reply.result.code == "forbidden" ? "This phone's pairing doesn't include Projects. Pair again with Projects turned on." : "Your computer answered \(reply.result.code ?? "unavailable").")
            }
            loaded = true
            projects = (more ? projects : []) + (reply.result.projects ?? []); next = reply.result.next
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

/// What Settings › Projects shows for the pages read so far and the search typed over them. A
/// search filters only what has been read, so the machine's next page stays on offer while it runs.
enum ProjectListing: Equatable {
    /// Nothing read yet and no read under way (offline): nothing to say about the list.
    case unread
    case reading
    case empty
    /// The matching projects, by id, and whether another page can be read.
    case rows(ids: [String], more: Bool)
    /// A search found nothing in the pages read; another page may still hold it.
    case noMatch(more: Bool)

    static func of(_ projects: [NativeProject], next: String?, loaded: Bool, reading: Bool, query: String) -> ProjectListing {
        if !loaded { return reading ? .reading : .unread }
        if projects.isEmpty { return .empty }
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = text.isEmpty ? projects : projects.filter {
            $0.name.localizedCaseInsensitiveContains(text) || $0.path.localizedCaseInsensitiveContains(text)
        }
        return matching.isEmpty ? .noMatch(more: next != nil) : .rows(ids: matching.map(\.id), more: next != nil)
    }
}

/// A project's row: its name, then its folder in mono, cut in the middle so both ends show.
private struct ProjectRowLabel: View {
    let project: NativeProject
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(project.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(2)
            Text(verbatim: project.path).aceMonospace(AceDesign.TextRole.code).foregroundStyle(AceDesign.Ink.muted)
                .lineLimit(1).truncationMode(.middle)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
    }
}
