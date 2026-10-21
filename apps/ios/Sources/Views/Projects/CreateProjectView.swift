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
        Form {
            if model.connection != "ready" { InboxConnectionBanner(connection: model.connection, retry: model.retry) }
            Section {
                if cloning { TextField("Repository URL", text: field(\.url)).accessibilityIdentifier("project.clone.url") }
                TextField("Project name", text: field(\.name)).accessibilityIdentifier("project.create.name")
                TextField("Parent folder on Mac", text: field(\.parent)).accessibilityIdentifier("project.create.parent")
            } footer: { Text("Created on your connected machine. The folder and repository are kept there.") }
            if !cloning {
                Section("Git") {
                    Toggle("Initialise a Git repository", isOn: Binding(get: { draft.git }, set: { value in drafts.edit { $0.git = value } }))
                    if draft.git {
                        TextField("Initial branch (\(initialBranch))", text: field(\.branch))
                        TextField(".gitignore contents", text: field(\.gitignore), axis: .vertical).lineLimit(3...8)
                    }
                }
            }
            ServiceProblem(message: problem ?? drafts.problem)
            if busy {
                if cloning, let progress = model.compose.clone, progress.id == draft.commandId {
                    if let percent = progress.percent { ProgressView(progress.label, value: percent, total: 100) }
                    else { ProgressView(progress.label) }
                } else { ProgressView(cloning ? "Cloning repository…" : "Creating project…") }
            }
            Button(cloning ? "Clone repository" : "Create project") { submission = Task { await submit() } }
                .disabled(!ready || busy || !model.canOperate || model.connection != "ready")
                .accessibilityIdentifier("project.create.submit")
        }
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
        guard await model.createProject(draft, cloning: cloning, requestId: id) else { problem = model.error ?? "Couldn't save the request. Your draft is still here."; return }
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
        problem = "Saved on this phone. You can leave this screen; retrying checks the same request."
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
