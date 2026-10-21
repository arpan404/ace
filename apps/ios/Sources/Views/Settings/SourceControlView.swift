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

/// Settings › Source control: the machine's GitHub CLI and accounts, the host, account and remote
/// ace expects, and how a chosen project's repository is reached.
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
        List {
            Section {
                if let status {
                    SourceValueRow(title: "CLI", value: status.cli == "available" ? "gh \(status.version ?? "")" : "Unavailable")
                    SourceValueRow(title: "GitHub API", value: status.api.replacingOccurrences(of: "_", with: " ").capitalized)
                    ForEach(status.accounts) { account in
                        SettingsRow(account.login, value: account.active ? "Active" : nil).accessibilityElement(children: .combine)
                    }
                    note(status.instructions)
                } else if busy {
                    SourceValueRow(title: "CLI", value: nil)
                }
                Button { Task { await read() } } label: {
                    SettingsActionLabel(title: "Rescan", value: busy ? "Checking…" : nil)
                }
                .buttonStyle(.plain).disabled(busy)
            } header: { SettingsHeader("GitHub CLI on your machine") }
            .settingsRow()
            Section {
                SettingsRow(title: "GitHub host") { field("GitHub host", prompt: "github.com", text: $host) }
                SettingsRow(title: "Expected account") { field("Expected account", prompt: "Optional", text: $account) }
                SettingsRow(title: "Git remote") { field("Git remote", prompt: "origin", text: $remote) }
                Button { Task { await save() } } label: { SettingsActionLabel(title: "Save preferences") }
                    .buttonStyle(.plain)
                    .disabled(status == nil || host.isEmpty || remote.isEmpty)
            } header: { SettingsHeader("Host and expected account") }
            .disabled(busy || !model.canOperate)
            .settingsRow()
            Section {
                SettingsRow(title: "Project") {
                    Picker("Project", selection: $project) {
                        Text("Choose project").tag("")
                        ForEach(projects) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
                if let status {
                    SourceValueRow(title: "Transport", value: status.transport.replacingOccurrences(of: "_", with: " ").capitalized)
                    note(status.transportInstructions)
                }
            } header: { SettingsHeader("Repository transport") }
            .settingsRow()
            if let problem {
                ServiceProblem(message: problem)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: SettingsStyle.margin,
                                              bottom: AceTheme.Spacing.sm, trailing: SettingsStyle.margin))
            }
        }
        .settingsList()
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
    /// A preference typed in place at the row's right edge, muted like a value.
    private func field(_ label: String, prompt: String, text: Binding<String>) -> some View {
        TextField(prompt, text: text)
            .multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled()
            .aceFont(SettingsStyle.value, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
            .accessibilityLabel(label)
    }
    /// What the machine says to do next, muted and selectable so a command can be copied.
    private func note(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
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

/// "GitHub API ─ Ready": a muted value, or a skeleton bar while it is read. The label stays one
/// accessible text found by its name, with the value as its value.
private struct SourceValueRow: View {
    let title: String
    let value: String?
    var body: some View {
        SettingsRow(title: title) {
            if let value {
                SettingsValue(text: value)
            } else {
                Capsule().fill(AceTheme.Colours.fill).frame(width: 64, height: 10)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value ?? "Checking")
        .accessibilityAddTraits(.isStaticText)
    }
}

