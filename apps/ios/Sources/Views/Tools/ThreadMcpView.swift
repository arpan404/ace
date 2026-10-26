import SwiftUI

private struct McpReply: Decodable {
    struct Sources: Decodable {
        struct Server: Decodable, Identifiable { let name: String; let status: String; var id: String { name } }
        let servers: [Server]
        let canAdd: Bool
        let live: Bool
        let appliesNextTurn: Bool
    }
    let result: Sources
}
struct ThreadMcpView: View {
    let model: ClientModel
    let threadId: String
    @State private var sources: McpReply.Sources?
    @State private var problem: String?
    @State private var name = ""
    @State private var address = ""
    @State private var busy = false
    var body: some View {
        Form {
            ServiceProblem(message: problem)
            if let sources {
                Section(sources.live ? "Connected session" : "Configured servers") {
                    ForEach(sources.servers) { server in
                        VStack(alignment: .leading) {
                            LabeledContent(server.name, value: server.status.replacingOccurrences(of: "_", with: " ").capitalized)
                            HStack {
                                Button(server.status == "disabled" ? "Enable" : "Disable") { perform(server.status == "disabled" ? "mcp.enable" : "mcp.disable", name: server.name) }
                                    .accessibilityIdentifier("mcp.toggle.\(server.name)")
                                Button("Reconnect") { perform("mcp.reconnect", name: server.name) }
                            }.buttonStyle(.borderless).disabled(busy || !model.canOperate)
                        }
                    }
                    if sources.servers.isEmpty { Text("No MCP servers configured.") }
                    if sources.appliesNextTurn { Text("Changes apply on the next turn.") }
                }
                if sources.canAdd && model.canOperate {
                    Section("Add HTTP server") {
                        TextField("Server name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("https://example.com/mcp", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Button("Add server") { perform("mcp.add", name: name, server: ["transport": "http", "url": address]) }
                            .disabled(name.isEmpty || address.isEmpty || busy)
                    }
                }
            } else if problem == nil { ProgressView("Reading servers…") }
        }
        .navigationTitle("MCP servers").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }.refreshable { await read() }
    }
    private func read() async {
        do { sources = try await model.service(["type": "mcp.sources", "threadId": threadId], as: McpReply.self).result; problem = nil }
        catch { problem = error.localizedDescription }
    }
    private func perform(_ type: String, name: String, server: [String: Any]? = nil) {
        busy = true
        Task {
            defer { busy = false }
            do {
                var payload: [String: Any] = ["type": type, "threadId": threadId, "name": name]
                if let server { payload["server"] = server }
                let reply = try await model.service(payload, as: ServiceValue.self)
                // Mutations return a status envelope, not a sources snapshot; read canonical state.
                if case .object(let root) = reply, case .object(let result) = root["result"], case .bool(false) = result["ok"] {
                    throw ServiceFailure(message: "The provider refused this MCP change.")
                }
                await read()
            } catch { problem = error.localizedDescription }
        }
    }
}
