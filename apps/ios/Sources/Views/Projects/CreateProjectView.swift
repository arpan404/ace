import SwiftUI

private struct ProjectHomeReply: Decodable {
    struct Result: Decodable { let kind: String; let path: String?; let initialBranch: String?; let code: String? }
    let result: Result
}

struct CreateProjectView: View {
    let model: ClientModel
    let cloning: Bool
    let added: (String) -> Void
    @State private var drafts: ProjectCreationDraftModel
    @State private var busy = false
    @State private var problem: String?
    @State private var initialBranch = "main"
    @State private var submission: Task<Void, Never>?
    @State private var cancelling = false
    private var draft: ProjectCreationDraft { drafts.draft }
    init(model: ClientModel, cloning: Bool, added: @escaping (String) -> Void) {
        self.model = model; self.cloning = cloning; self.added = added
        _drafts = State(initialValue: ProjectCreationDraftModel(hostId: model.hostId ?? "unpaired", cloning: cloning))
    }
    var body: some View {
        List {
            if model.connection != "ready" {
                Section { InboxConnectionBanner(connection: model.connection, retry: model.retry) }
                    .listRowBackground(Color.clear)
            }
            if let message = problem ?? drafts.problem {
                Section { ProblemRow(message, id: "project.create.problem") }
            }
            if cloning {
                Section {
                    NavigationLink {
                        GitHubRepositoriesView(model: model) { row in
                            drafts.edit { $0.url = row.cloneUrl; $0.name = row.name }
                            problem = nil
                        }
                    } label: { InsetRow("Choose from GitHub", icon: nil, subtitle: "Your repositories, through gh on the computer") }
                    .accessibilityIdentifier("project.clone.github")
                }
                .insetRowBackground()
            }
            Section {
                if cloning { TextField("Repository URL", text: field(\.url)).keyboardType(.URL).accessibilityIdentifier("project.clone.url") }
                TextField("Project name", text: field(\.name)).accessibilityIdentifier("project.create.name")
                TextField("Parent folder", text: field(\.parent)).font(AceDesign.Typeface.code).accessibilityIdentifier("project.create.parent")
            } footer: { Text("The folder is made on your computer.") }
            .insetRowBackground()
            if !cloning {
                Section {
                    Toggle("Initialise a Git repository", isOn: Binding(get: { draft.git }, set: { value in drafts.edit { $0.git = value } }))
                    if draft.git {
                        TextField("Initial branch (\(initialBranch))", text: field(\.branch))
                        TextField(".gitignore contents", text: field(\.gitignore), axis: .vertical).lineLimit(3...8)
                    }
                } header: { InsetHeader("Git") }
                .insetRowBackground()
            }
            Section {
                VStack(spacing: AceDesign.Space.related) {
                    if busy { progress }
                    Button { submission = Task { await submit() } } label: {
                        Text(cloning ? "Clone repository" : "Create project").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primaryAction).controlSize(.large)
                    .disabled(!ready || busy || !model.canOperate || model.connection != "ready")
                    .accessibilityIdentifier("project.create.submit")
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
        .insetGroupedList()
        .smoothChange(busy)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(busy)
        .navigationTitle(cloning ? "Clone repository" : "New project").navigationBarTitleDisplayMode(.inline)
        .task { await home() }
        .onDisappear { submission?.cancel(); submission = nil }
        .toolbar {
            if cloning, busy {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel clone") { Task { await cancelClone() } }.disabled(cancelling || model.connection != "ready")
                }
            }
        }
    }
    @ViewBuilder private var progress: some View {
        if cloning, let progress = model.compose.clone, progress.id == draft.commandId {
            if let percent = progress.percent { ProgressView(progress.label, value: percent, total: 100) }
            else { HStack(spacing: AceDesign.Space.related) { WorkingMark(); Text(progress.label) } }
        } else {
            HStack(spacing: AceDesign.Space.related) { WorkingMark(); Text(cloning ? "Cloning repository…" : "Creating project…") }
                .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
        }
    }

    private var ready: Bool {
        !draft.parent.isEmpty && draft.parent.utf16.count <= 4096 && !draft.name.isEmpty && draft.name.utf16.count <= 256 &&
        draft.branch.utf16.count <= 1024 && draft.gitignore.utf16.count <= 65536 && (!cloning || (!draft.url.isEmpty && draft.url.utf16.count <= 4096))
    }
    private func field(_ key: WritableKeyPath<ProjectCreationDraft, String>) -> Binding<String> {
        Binding(get: { draft[keyPath: key] }, set: { value in drafts.edit { $0[keyPath: key] = value }; problem = nil })
    }
    private func home() async {
        guard draft.parent.isEmpty else { return }
        do {
            let reply = try await model.service(["type": "projects.request", "operation": ["op": "fs.home"]], as: ProjectHomeReply.self)
            guard reply.result.kind == "home", let path = reply.result.path else { throw ServiceFailure(message: reply.result.code ?? "Couldn't read the machine's home folder") }
            initialBranch = reply.result.initialBranch ?? "main"
            if draft.parent.isEmpty { drafts.edit { $0.parent = path } }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func submit() async {
        guard ready, !busy, model.canOperate, model.connection == "ready", let id = drafts.reserve(make: { "project-" + UUID().uuidString.lowercased() }) else { return }
        busy = true; problem = nil
        defer { busy = false }
        guard await model.createProject(draft, cloning: cloning, requestId: id) else { problem = model.error ?? "Couldn't send it. Your draft is kept."; return }
        guard !Task.isCancelled else { return }
        // Clones can outlive the sheet. The durable command continues and keeps this identity.
        for _ in 0..<600 {
            if let receipt = model.compose.added[id] {
                drafts.received(ok: receipt.ok)
                if receipt.ok, let project = receipt.id { model.composeAction(["kind": "projects"]); added(project) }
                else { problem = receipt.message }
                return
            }
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
        problem = "Your computer hasn't answered yet. You can leave this screen; it keeps going."
    }
    private func cancelClone() async {
        guard let id = draft.commandId, !cancelling else { return }
        cancelling = true; defer { cancelling = false }
        do {
            let reply = try await model.service(["type": "projects.request", "operation": ["op": "workspace.clone.cancel", "commandId": id]], as: ProjectHomeReply.self)
            guard reply.result.kind == "cancelled" else { throw ServiceFailure(message: reply.result.code ?? "Couldn't cancel the clone") }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
