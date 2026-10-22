import SwiftUI

struct PromptFileRow: Codable, Identifiable {
    let name: String
    let title: String
    let description: String
    let scope: ServiceValue
    var id: String { name }
}
private struct PromptsReply: Decodable {
    struct Result: Decodable {
        let kind: String
        let files: [PromptFileRow]?
        let text: String?
        let revision: String?
        let message: String?
    }
    let result: Result
}
struct PromptsView: View {
    let model: ClientModel
    @State private var files: [PromptFileRow] = []
    @State private var problem: String?
    @State private var adding = false
    var body: some View {
        List {
            ServiceProblem(message: problem).listRowBackground(Color.clear)
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
                NavigationLink { PromptEditor(model: model, file: nil) } label: { InsetRow("New prompt", systemImage: "plus") }
                    .disabled(!model.canOperate)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Prompts").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }.refreshable { await read() }
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "prompts.request", "operation": ["op": "list"]], as: PromptsReply.self)
            guard reply.result.kind == "list" else { throw ServiceFailure(message: reply.result.message ?? "Couldn't read prompts") }
            files = reply.result.files ?? []; problem = nil
        } catch { problem = error.localizedDescription }
    }
}
private struct PromptEditor: View {
    let model: ClientModel
    let file: PromptFileRow?
    @State private var name = ""
    @State private var text = ""
    @State private var revision: String?
    @State private var loaded = false
    @State private var busy = false
    @State private var problem: String?
    @State private var saved = false
    var body: some View {
        Form {
            Group {
                if file == nil { TextField("filename.md", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled() }
                TextEditor(text: $text).frame(minHeight: AceTheme.Dimensions.touchTarget * 5).scrollContentBackground(.hidden)
                    .accessibilityLabel("Prompt instructions")
                ServiceProblem(message: problem)
                Button(saved ? "Saved" : "Save prompt") { Task { await save() } }
                    .disabled(!loaded || busy || !model.canOperate || name.isEmpty)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle(file?.title ?? "New prompt").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }
        .onChange(of: text) { saved = false }
    }
    private var scope: Any {
        guard let file, let data = try? JSONEncoder().encode(file.scope), let value = try? JSONSerialization.jsonObject(with: data) else { return ["kind": "global"] }
        return value
    }
    private func read() async {
        guard let file else { loaded = true; return }
        name = file.name
        do {
            let reply = try await model.service(["type": "prompts.request", "operation": ["op": "read", "scope": scope, "name": name]], as: PromptsReply.self)
            guard reply.result.kind == "file", let text = reply.result.text, let revision = reply.result.revision else { throw ServiceFailure(message: reply.result.message ?? "Couldn't read prompt") }
            self.text = text; self.revision = revision; loaded = true
        } catch { problem = error.localizedDescription }
    }
    private func save() async {
        busy = true; saved = false
        defer { busy = false }
        do {
            let expected: Any = revision.map { $0 as Any } ?? NSNull()
            let reply = try await model.service(["type": "prompts.request", "operation": ["op": "write", "scope": scope, "name": name, "text": text, "expectedRevision": expected]], as: PromptsReply.self)
            guard reply.result.kind == "file" else { throw ServiceFailure(message: reply.result.message ?? "Couldn't save prompt") }
            revision = reply.result.revision; saved = true; problem = nil
        } catch { problem = error.localizedDescription }
    }
}
