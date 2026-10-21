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
/// Settings › Prompts: the machine's saved prompt files, each opening its editor, and a new one.
struct PromptsView: View {
    let model: ClientModel
    @State private var files: [PromptFileRow] = []
    @State private var problem: String?
    @State private var adding = false
    @State private var loaded = false
    var body: some View {
        List {
            if loaded && files.isEmpty && problem == nil {
                EmptyState(icon: .notePencil, title: "No prompts yet", line: "Save reusable instructions as prompts.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            Section {
                ServiceProblem(message: problem)
                ForEach(files) { file in
                    NavigationLink { PromptEditor(model: model, file: file) } label: {
                        SettingsRow(title: file.title.isEmpty ? file.name : file.title,
                                    description: file.description.isEmpty ? nil : file.description) { EmptyView() }
                            .lineLimit(2)
                    }
                }
                NavigationLink { PromptEditor(model: model, file: nil) } label: {
                    SettingsRow(title: "New prompt") { AceIcon(.plus, size: 16).foregroundStyle(AceTheme.Colours.subtleForeground) }
                }
                .disabled(!model.canOperate)
            } header: { SettingsHeader("Prompts", note: "Reusable instructions saved on this machine.") }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Prompts").navigationBarTitleDisplayMode(.inline)
        .task { await read() }.refreshable { await read() }
    }
    private func read() async {
        defer { loaded = true }
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
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let cannotSave = !loaded || busy || !model.canOperate || name.isEmpty
        List {
            if file == nil {
                Section {
                    TextField("filename.md", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .aceFont(SettingsStyle.label, relativeTo: .body)
                } header: { SettingsHeader("File name") }
                .settingsRow()
            }
            Section {
                TextEditor(text: $text)
                    .aceFont(SettingsStyle.label, relativeTo: .body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget * 5).accessibilityLabel("Prompt instructions")
                ServiceProblem(message: problem)
            } header: { SettingsHeader("Instructions") }
            .settingsRow()
            Section {
                Button { Task { await save() } } label: { SettingsRow(title: saved ? "Saved" : "Save prompt") { EmptyView() } }
                    .buttonStyle(.plain)
                    .disabled(cannotSave)
                    .opacity(cannotSave ? AceTheme.Opacity.disabled(scheme) : 1)
            }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle(file?.title ?? "New prompt").navigationBarTitleDisplayMode(.inline)
        .task { await read() }
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
