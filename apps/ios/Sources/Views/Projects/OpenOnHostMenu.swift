import SwiftUI

private struct OpenersReply: Decodable {
    struct Editor: Decodable, Identifiable { let id: String; let name: String }
    let editors: [Editor]
    let fileManager: String?
}

/// Where a project, thread or file is: `workspaceId` or `threadId`, and a path inside it.
struct HostOpenTarget: Equatable {
    var workspaceId: String? = nil
    var threadId: String? = nil
    var path: String? = nil
    var line: Int? = nil
    var json: [String: Any] {
        var value: [String: Any] = [:]
        if let workspaceId { value["workspaceId"] = workspaceId }
        if let threadId { value["threadId"] = threadId }
        if let path { value["path"] = path }
        if let line { value["line"] = line }
        return value
    }
}

/// "Open in…": the editors the machine running ace has, and its file manager. Picking one opens
/// the target there, on that machine (`workspace.request` `host.open`); the phone has none.
struct OpenOnHostMenu<Label: View>: View {
    let model: ClientModel
    let target: HostOpenTarget
    @ViewBuilder var label: () -> Label
    @State private var openers: OpenersReply?
    @State private var problem: String?
    @State private var opened = 0

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
        } label: { label() }
        .disabled(!model.canOperate || model.connection != "ready")
        .task(id: model.connection) { await read() }
        .sensoryFeedback(.success, trigger: opened)
        .alert("Couldn't open it", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK") { problem = nil }
        } message: { Text(problem ?? "") }
    }

    private func read() async {
        guard model.connection == "ready", openers == nil else { return }
        openers = try? await model.service(["type": "native.project", "request": ["op": "openers"]], as: OpenersReply.self)
    }
    private func open(_ app: [String: Any]) {
        Task {
            var request = target.json
            request["op"] = "open"
            request["app"] = app
            let outcome = await model.projectWrite(request)
            if outcome.ok { opened += 1 } else { problem = outcome.message ?? "Try again." }
        }
    }
}
