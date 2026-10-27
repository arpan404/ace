import SwiftUI

/// Open on computer: the skill's SKILL.md in an editor on the machine running ace, or its folder
/// in that machine's file manager (`bridge/skill-library.ts`, `host.open`). The menu lists what
/// the machine has; the phone sends the skill's id, and the machine finds its file.
struct SkillOpenOnComputer: View {
    let model: ClientModel
    let skillId: String
    let workspaceId: String?
    @State private var openers: Openers?
    @State private var problem: String?
    @State private var opened = 0

    private struct Openers: Decodable {
        struct Editor: Decodable, Identifiable { let id: String; let name: String }
        let editors: [Editor]
        let fileManager: String?
    }
    private var at: [String: Any] { workspaceId.map { ["workspaceId": $0] } ?? [:] }

    var body: some View {
        Menu {
            if let openers {
                ForEach(openers.editors) { editor in
                    Button(editor.name) { open(["kind": "editor", "editorId": editor.id]) }
                }
                if let files = openers.fileManager {
                    if !openers.editors.isEmpty { Divider() }
                    Button("Show in \(files)") { open(["kind": "files"]) }
                }
                if openers.editors.isEmpty && openers.fileManager == nil { Text("No editors on this machine") }
            } else {
                Text("Looking for editors…")
            }
        } label: {
            HStack {
                Text("Open on computer").aceFont(InsetStyle.label, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
                Spacer(minLength: AceTheme.Spacing.sm)
            }
            .frame(minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .disabled(model.connection != "ready")
        .accessibilityIdentifier("skill.openOnComputer")
        .task(id: model.connection) { await read() }
        .sensoryFeedback(.success, trigger: opened)
        .alert("Couldn't open it", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") { problem = nil }
        } message: { Text(problem ?? "") }
    }

    private func read() async {
        guard model.connection == "ready", openers == nil else { return }
        openers = try? await model.skills(["op": "openers", "id": skillId].merging(at) { $1 }, as: Openers.self)
    }
    private func open(_ app: [String: Any]) {
        Task {
            do {
                _ = try await model.skills(["op": "open", "id": skillId, "app": app].merging(at) { $1 }, as: ServiceValue.self)
                opened += 1
            } catch { problem = error.localizedDescription }
        }
    }
}
