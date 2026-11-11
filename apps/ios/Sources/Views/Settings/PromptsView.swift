import SwiftUI

struct PromptFileRow: Codable, Identifiable {
    let name: String
    let title: String
    let description: String
    let scope: ServiceValue
    struct Diagnostic: Codable { let message: String }
    var diagnostics: [Diagnostic]? = nil
    var id: String {
        if case .object(let fields) = scope, case .string(let workspace)? = fields["workspaceId"] { return "project/\(workspace)/\(name)" }
        return "global/\(name)"
    }
}
private struct PromptsReply: Decodable {
    struct Result: Decodable {
        let kind: String
        let files: [PromptFileRow]?
        let text: String?
        let revision: String?
        let message: String?
        let code: String?
        let file: PromptFileRow?
    }
    let result: Result
}
struct PromptsView: View {
    let model: ClientModel
    @State private var files: [PromptFileRow] = []
    @State private var problem: String?
    @State private var loading = true
    @State private var listSequence = 0
    @State private var projectsProblem: String?
    @State private var projects: [NativeProject] = []
    @State private var workspaceId = ""
    private static func listRead(_ workspaceId: String) -> [String: Any] {
        var operation: [String: Any] = ["op": "list"]
        if !workspaceId.isEmpty { operation["workspaceId"] = workspaceId }
        return ["type": "prompts.request", "operation": operation]
    }
    private var listRead: [String: Any] { Self.listRead(workspaceId) }

    /// Opens on the last prompts this phone saw, read again behind them.
    init(model: ClientModel) {
        self.model = model
        _files = State(initialValue: model.kept(Self.listRead(""), as: PromptsReply.self)?.result.files ?? [])
    }
    var body: some View {
        List {
            Section {
                Picker("Project", selection: $workspaceId) {
                    Text("Global prompts").tag("")
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }
                ServiceProblem(message: projectsProblem)
                if projectsProblem != nil { Button("Retry") { Task { await readProjects() } }.buttonStyle(.textAction()) }
            }.insetRowBackground()
            ServiceProblem(message: problem).listRowBackground(Color.clear)
            if problem != nil { Button("Retry") { Task { await read() } }.buttonStyle(.textAction()) }
            if loading && files.isEmpty && problem == nil {
                SkeletonRows(count: 2, label: "Loading prompts").listRowBackground(Color.clear)
            } else if !loading && files.isEmpty && problem == nil {
                EmptyState(systemImage: "text.page", title: "No prompts yet", line: "Create a prompt to reuse instructions.").listRowBackground(Color.clear)
            }
            if !files.isEmpty {
                Section {
                    ForEach(files) { file in
                        NavigationLink { PromptEditor(model: model, file: file) } label: {
                            InsetRow(systemImage: nil, title: file.title.isEmpty ? file.name : file.title,
                                     subtitle: file.description.isEmpty ? nil : file.description) { EmptyView() }
                        }
                    }
                }
                .insetRowBackground()
            }
            Section {
                NavigationLink { PromptEditor(model: model, file: nil, workspaceId: workspaceId) } label: { InsetRow("New prompt", systemImage: "plus") }
                    .disabled(!model.canOperate)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .nativeTitle("Prompts")
        .onChange(of: workspaceId) { files = []; problem = nil; loading = true }
        .readWhenConnected(model) { await readProjects() }
        .task(id: "\(workspaceId)/\(model.connection)/\(model.readGeneration(listRead))") { await read() }.refreshable { await read() }
    }
    private func readProjects() async {
        do {
            let reply = try await model.read(["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]], as: ProjectListReply.self)
            guard let projects = reply.result.projects else { throw ServiceFailure(message: "Couldn't read projects.") }
            self.projects = projects; projectsProblem = nil
        } catch { if !Task.isCancelled { projectsProblem = error.localizedDescription } }
    }
    private func read() async {
        let selected = workspaceId
        listSequence += 1
        let sequence = listSequence
        loading = true
        defer { if sequence == listSequence { loading = false } }
        do {
            let reply = try await model.read(Self.listRead(selected), as: PromptsReply.self)
            guard reply.result.kind == "list" else { throw ServiceFailure(message: reply.result.message ?? "Couldn't read prompts") }
            guard workspaceId == selected, sequence == listSequence, !Task.isCancelled else { return }
            files = reply.result.files ?? []; problem = nil
        } catch { if sequence == listSequence && !Task.isCancelled { problem = error.localizedDescription } }
    }
}
private struct PromptEditor: View {
    let model: ClientModel
    let file: PromptFileRow?
    var workspaceId = ""
    @State private var name = ""
    @State private var draft = PromptDraft()
    @State private var loaded = false
    @State private var busy = false
    @State private var problem: String?
    /// The operation that last failed, so Retry repeats it instead of guessing from `loaded`.
    @State private var failure: PromptFailure?
    @State private var saved = false
    var body: some View {
        Form {
            Group {
                if file == nil { TextField("filename.md", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled() }
                TextEditor(text: $draft.text).frame(minHeight: AceDesign.Size.tap * 5).scrollContentBackground(.hidden)
                    .accessibilityLabel("Prompt instructions")
                    .disabled(file != nil && !loaded)
                ServiceProblem(message: problem)
                if let failure {
                    if let retried = failure.retry {
                        Button("Retry") { Task { await retry(retried) } }.buttonStyle(.textAction()).disabled(busy)
                    } else {
                        Button("Reload from machine") { Task { await reload() } }.buttonStyle(.textAction()).disabled(busy)
                    }
                }
                if draft.reloadAvailable && failure != .conflict {
                    Text("The machine reconnected. Your unsaved edits are kept.").foregroundStyle(AceDesign.Ink.muted)
                    Button("Reload from machine") { Task { await reload() } }.buttonStyle(.textAction()).disabled(busy)
                }
                Button(saved ? "Saved" : "Save prompt") { Task { await save() } }
                    .disabled(!loaded || busy || !model.canOperate || name.isEmpty)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle(file?.title ?? "New prompt").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }
        .onChange(of: draft.text) { saved = false }
    }
    private var scope: Any {
        guard let file, let data = try? JSONEncoder().encode(file.scope), let value = try? JSONSerialization.jsonObject(with: data) else { return workspaceId.isEmpty ? ["kind": "global"] : ["kind": "project", "workspaceId": workspaceId] }
        return value
    }
    private func read() async {
        guard let file else { loaded = true; return }
        name = file.name
        do {
            let snapshot = try await readFile()
            draft.receive(text: snapshot.text, revision: snapshot.revision); loaded = true
            // A failed save keeps its place: the person still has edits to send.
            if failure != .save && failure != .conflict { failure = nil; problem = nil }
        } catch { if !Task.isCancelled { failed(.read, error) } }
    }
    private func readFile() async throws -> (text: String, revision: String) {
        let reply = try await model.service(["type": "prompts.request", "operation": ["op": "read", "scope": scope, "name": file?.name ?? name]], as: PromptsReply.self)
        guard reply.result.kind == "file", let text = reply.result.text, let revision = reply.result.revision else {
            throw ServiceFailure(message: reply.result.message ?? "Couldn't read prompt")
        }
        return (text, revision)
    }
    private func reload() async {
        busy = true
        defer { busy = false }
        do {
            let snapshot = try await readFile()
            draft = PromptDraft()
            draft.receive(text: snapshot.text, revision: snapshot.revision)
            loaded = true; saved = false; problem = nil; failure = nil
        } catch { if !Task.isCancelled { failed(.reload, error) } }
    }
    private func retry(_ operation: PromptFailure) async {
        switch operation {
        case .read: await read()
        case .reload, .conflict: await reload()
        case .save: await save()
        }
    }
    private func failed(_ operation: PromptFailure, _ error: any Error) {
        failure = operation; problem = error.localizedDescription
    }
    private func save() async {
        busy = true; saved = false
        defer { busy = false }
        do {
            let written = draft.text
            let expected: Any = draft.revision.map { $0 as Any } ?? NSNull()
            let reply = try await model.service(["type": "prompts.request", "operation": ["op": "write", "scope": scope, "name": name, "text": written, "expectedRevision": expected]], as: PromptsReply.self)
            guard reply.result.kind == "file" else {
                // The machine's copy changed under this draft, so this revision can never land.
                failure = reply.result.code == "conflict" ? .conflict : .save
                problem = reply.result.message ?? "Couldn't save prompt"
                return
            }
            draft.saved(text: written, revision: reply.result.revision)
            let diagnostics = reply.result.file?.diagnostics ?? []
            saved = diagnostics.isEmpty && !draft.dirty
            failure = nil
            problem = diagnostics.isEmpty ? nil : diagnostics.map(\.message).joined(separator: "\n")
        } catch {
            failure = .save
            problem = error.localizedDescription
        }
    }
}
