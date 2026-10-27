import SwiftUI

struct McpServerRowData: Decodable, Identifiable, Equatable {
    let name: String
    let word: String?
    let off: Bool
    let failed: Bool
    var id: String { name }
}
struct McpScreenData: Decodable, Equatable {
    let managed: Bool
    let servers: [McpServerRowData]
    let canAdd: Bool
    let note: String?
}
private struct McpAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let screen: McpScreenData?
}

/// A provider's own MCP servers as its latest live session reports them: a state word, Turn
/// off or Turn on and Reconnect for each, then Add MCP server. The provider's own configuration
/// and permissions govern them; ace adds no approval of its own.
struct ProviderMcpView: View {
    let model: ClientModel
    let provider: String
    let name: String
    @State private var screen: McpScreenData?
    @State private var problem: String?
    @State private var note: String?
    @State private var working: String?
    @State private var adding = false
    @State private var changed = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        List {
            Group {
                if let screen {
                    Section {
                        ForEach(screen.servers) { server in row(server) }
                        if screen.canAdd, model.canOperate {
                            Button("Add MCP server") { adding = true }.frame(minHeight: 44)
                        }
                    } footer: { if let text = screen.note { Text(text) } }
                } else if problem == nil {
                    Section { ForEach(0..<2, id: \.self) { _ in InsetRow("Server name", systemImage: nil, value: "Connected") } }
                        .redacted(reason: .placeholder)
                }
                if let message = problem ?? note {
                    Section {
                        ServiceProblem(message: message)
                        if problem != nil { Button("Retry") { Task { await read() } } }
                    }
                    .transition(.opacity)
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: screen)
        .navigationTitle("MCP servers").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: provider) { await read() }.refreshable { await read() }
        .sensoryFeedback(.success, trigger: changed)
        .sheet(isPresented: $adding) {
            NavigationStack {
                AddMcpServerView(model: model, provider: provider, taken: screen?.servers.map(\.name) ?? []) {
                    changed += 1
                    Task { await read() }
                }
            }
        }
    }
    private func row(_ server: McpServerRowData) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack {
                Text(server.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                if working == server.name { ProgressView().controlSize(.small) }
                else if let word = server.word {
                    Text(word).aceFont(InsetStyle.value, relativeTo: .body)
                        .foregroundStyle(server.failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                        .contentTransition(.opacity)
                }
            }
            if model.canOperate {
                HStack(spacing: AceTheme.Spacing.lg) {
                    Button(server.off ? "Turn on" : "Turn off") { control(server, server.off ? "enable" : "disable") }
                    if !server.off { Button("Reconnect") { control(server, "reconnect") } }
                }
                .buttonStyle(.borderless)
                .aceFont(InsetStyle.value, relativeTo: .body)
                .disabled(working != nil)
            }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
    }
    private func control(_ server: McpServerRowData, _ action: String) {
        working = server.name; note = nil
        Task {
            defer { working = nil }
            do {
                _ = try await model.manage(["type": "mcp.screen.control", "provider": provider, "name": server.name, "action": action], as: PlainAnswer.self)
                changed += 1
                await read()
            } catch { withAnimation(.smooth) { note = error.localizedDescription } }
        }
    }
    private func read() async {
        do {
            let answer = try await model.manage(["type": "mcp.screen", "provider": provider], as: McpAnswer.self)
            screen = answer.screen; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

private struct CheckAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let field: String?
}

/// Add a URL server, or a command with its arguments, to the provider's own configuration.
struct AddMcpServerView: View {
    let model: ClientModel
    let provider: String
    let taken: [String]
    let added: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var transport = "command"
    @State private var address = ""
    @State private var check: CheckAnswer?
    @State private var problem: String?
    @State private var busy = false
    var body: some View {
        Form {
            Group {
                Section {
                    TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !name.isEmpty, check?.field == "name", let text = check?.problem { fieldProblem(text) }
                } header: { InsetHeader("Name") }
                Section {
                    Picker("Connection", selection: $transport) {
                        Text("Command").tag("command")
                        Text("URL").tag("http")
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: AceTheme.Spacing.md, bottom: AceTheme.Spacing.sm, trailing: AceTheme.Spacing.md))
                    TextField(transport == "http" ? "https://example.com/mcp" : "npx -y @scope/server --flag", text: $address, axis: .vertical)
                        .lineLimit(1...4)
                        .monospaced()
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(transport == "http" ? .URL : .asciiCapable)
                    if !address.isEmpty, check?.field == "address", let text = check?.problem { fieldProblem(text) }
                } header: { InsetHeader(transport == "http" ? "Server URL" : "Command and arguments") } footer: {
                    Text("Saved in the agent's own configuration. Set environment variables and sign-in headers there; keep secrets out of these fields.")
                }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth(duration: 0.2), value: transport)
        .animation(.smooth(duration: 0.2), value: check?.problem)
        .navigationTitle("Add MCP server").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            ToolbarItem(placement: .confirmationAction) {
                Button(busy ? "Adding…" : "Add") { Task { await add() } }
                    .disabled(busy || check?.field != nil || check == nil || !model.canOperate)
            }
        }
        .task(id: [name, transport, address]) {
            check = try? await model.manage(["type": "mcp.screen.check", "name": name, "transport": transport, "address": address, "taken": taken], as: CheckAnswer.self)
        }
        .interactiveDismissDisabled(busy)
    }
    private func fieldProblem(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.StatusText.failed).transition(.opacity)
    }
    private func add() async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            _ = try await model.manage(["type": "mcp.screen.add", "provider": provider, "name": name, "transport": transport, "address": address, "taken": taken], as: PlainAnswer.self)
            added(); dismiss()
        } catch { problem = error.localizedDescription }
    }
}
