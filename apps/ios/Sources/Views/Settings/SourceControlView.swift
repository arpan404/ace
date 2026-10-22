import SwiftUI

struct NativeSourceControl: Decodable {
    struct Preferences: Codable {
        struct Host: Codable { let host: String; let account: String? }
        let hosts: [Host]
        let host: String
        let remote: String
    }
    struct Account: Decodable, Identifiable { let login: String; let active: Bool; var id: String { login } }
    let preferences: Preferences
    let cli: String
    let version: String?
    let accounts: [Account]
    let account: String?
    let api: String
    let instructions: String
    let transport: String
    let transportInstructions: String
}
struct NativeSourceControlReply: Decodable {
    struct Result: Decodable { let kind: String; let readiness: NativeSourceControl?; let code: String? }
    let result: Result
}

struct SourceControlView: View {
    let model: ClientModel
    @State private var status: NativeSourceControl?
    @State private var host = "github.com"
    @State private var account = ""
    @State private var remote = "origin"
    @State private var projects: [NativeProject] = []
    @State private var project = ""
    @State private var problem: String?
    @State private var busy = false
    var body: some View {
        Form {
            Group {
                Section {
                    if let status {
                        LabeledContent("CLI", value: status.cli == "available" ? "gh \(status.version ?? "")" : "Unavailable")
                        LabeledContent("GitHub API", value: status.api.replacingOccurrences(of: "_", with: " ").capitalized)
                        ForEach(status.accounts) { account in LabeledContent(account.login, value: account.active ? "Active" : "") }
                        Text(status.instructions).textSelection(.enabled)
                    }
                    Button("Rescan") { Task { await read() } }.disabled(busy)
                } header: { InsetHeader("GitHub CLI on your machine") }
                Section {
                    LabeledContent("GitHub host") { TextField("github.com", text: $host).multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    LabeledContent("Expected account") { TextField("Optional", text: $account).multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    LabeledContent("Git remote") { TextField("origin", text: $remote).multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    Button("Save preferences") { Task { await save() } }.disabled(status == nil || host.isEmpty || remote.isEmpty)
                } header: { InsetHeader("Host and expected account") }
                .disabled(busy || !model.canOperate)
                Section {
                    Picker("Project", selection: $project) {
                        Text("Choose project").tag("")
                        ForEach(projects) { Text($0.name).tag($0.id) }
                    }
                    if let status {
                        LabeledContent("Transport", value: status.transport.replacingOccurrences(of: "_", with: " ").capitalized)
                        Text(status.transportInstructions).textSelection(.enabled)
                    }
                } header: { InsetHeader("Repository transport") }
                if busy { ProgressView("Checking source control…") }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Source control").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) {
            guard model.connection == "ready" else { return }
            do {
                let reply = try await model.service(["type": "projects.request", "operation": ["op": "workspace.list", "limit": 100]], as: ProjectListReply.self)
                projects = reply.result.projects ?? []
            } catch { if !Task.isCancelled { problem = error.localizedDescription } }
            await read()
        }
        .task(id: project) { if model.connection == "ready" { await read() } }
    }
    private func read() async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            var operation: [String: Any] = ["op": "readiness"]
            if !project.isEmpty { operation["workspaceId"] = project }
            let reply = try await model.service(["type": "source-control.request", "operation": operation], as: NativeSourceControlReply.self)
            guard let status = reply.result.readiness else { throw ServiceFailure(message: "Couldn't check source control: \(reply.result.code ?? "unavailable")") }
            self.status = status; host = status.preferences.host; remote = status.preferences.remote
            account = status.preferences.hosts.first { $0.host == host }?.account ?? ""
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func save() async {
        guard let status else { return }
        busy = true; problem = nil
        do {
            var hosts = status.preferences.hosts.filter { $0.host != host }
            hosts.append(.init(host: host, account: account.isEmpty ? nil : account))
            let preferences = NativeSourceControl.Preferences(hosts: hosts, host: host, remote: remote)
            let encoded = try JSONEncoder().encode(preferences)
            let value = try JSONSerialization.jsonObject(with: encoded)
            struct SaveReply: Decodable { struct Diagnostic: Decodable { let message: String }; let ok: Bool; let diagnostics: [Diagnostic] }
            let reply = try await model.service(["type": "settings.set", "key": "sourceControl.preferences", "layer": ["kind": "global"], "value": value], as: SaveReply.self)
            guard reply.ok else { throw ServiceFailure(message: reply.diagnostics.first?.message ?? "Couldn't save source control preferences.") }
            await read()
        } catch { problem = error.localizedDescription }
        busy = false
    }
}
