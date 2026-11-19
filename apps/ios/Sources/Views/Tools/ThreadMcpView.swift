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
        List {
            if let problem {
                ProblemRow(problem, id: "mcp.problem", disabled: busy) { Task { await read() } }
            }
            if let sources {
                Section {
                    ForEach(sources.servers) { server in
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            InsetRow(server.name, systemImage: nil,
                                     value: server.status.replacingOccurrences(of: "_", with: " ").capitalized)
                            HStack(spacing: AceDesign.Space.related) {
                                Button(server.status == "disabled" ? "Enable" : "Disable") {
                                    perform(server.status == "disabled" ? "mcp.enable" : "mcp.disable", name: server.name)
                                }
                                .accessibilityIdentifier("mcp.toggle.\(server.name)")
                                Button("Reconnect") { perform("mcp.reconnect", name: server.name) }
                            }
                            .buttonStyle(.secondaryAction)
                            .controlSize(.small)
                            .disabled(busy || !model.canOperate)
                        }
                        .padding(.vertical, AceDesign.Space.tight)
                    }
                    if sources.servers.isEmpty {
                        Text("No MCP servers configured").foregroundStyle(AceDesign.Ink.muted)
                    }
                } header: {
                    InsetHeader(sources.live ? "Connected session" : "Configured servers")
                } footer: {
                    if sources.appliesNextTurn { Text("Changes apply on the next turn.") }
                }
                .insetRowBackground()
                if sources.canAdd && model.canOperate {
                    Section {
                        TextField("Server name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("https://example.com/mcp", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Button("Add server") { perform("mcp.add", name: name, server: ["transport": "http", "url": address]) }
                            .buttonStyle(.rowAction)
                            .disabled(name.isEmpty || address.isEmpty || busy)
                    } header: {
                        InsetHeader("Add HTTP server")
                    }
                    .insetRowBackground()
                }
            } else if problem == nil {
                SkeletonRows(count: 3, label: "Reading servers").listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
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
