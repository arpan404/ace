import SwiftUI

struct RemoteSetting: Identifiable {
    enum Control { case toggle, choices([String]), text, number, stringList }
    let key: String
    let title: String
    let control: Control
    var id: String { key }
}
struct RemoteSettingsCategory: Identifiable {
    let title: String
    let settings: [RemoteSetting]
    var id: String { title }
    static let computer = RemoteSettingsCategory(title: "App access and devices", settings: [
        .init(key: "computer.blockedApps", title: "Apps agents can't use", control: .stringList),
        .init(key: "devices.emulatorWindow", title: "Show emulator window", control: .toggle),
    ])
    static let all: [RemoteSettingsCategory] = [
        .init(title: "Threads", settings: [
            .init(key: "threads.followUpBehavior", title: "Follow-up delivery", control: .choices(["steer", "queue"])),
            .init(key: "threads.forkOnSwitch", title: "Fork when switching agents", control: .toggle),
            .init(key: "threads.useWorktree", title: "Use worktrees", control: .toggle),
            .init(key: "threads.autoSettleAfter", title: "Settle inactive threads", control: .choices(["1d", "2d", "1w", "never"])),
            .init(key: "threads.unresponsiveAfter", title: "Mark unresponsive after", control: .choices(["2m", "5m", "15m"])),
            .init(key: "threads.settleOnMerge", title: "Settle merged pull requests", control: .toggle),
            .init(key: "threads.settleOnClose", title: "Settle closed pull requests", control: .toggle),
            .init(key: "threads.sortBy", title: "Sort threads", control: .choices(["activity", "created", "manual"])),
            .init(key: "access.defaultMode", title: "Default access", control: .choices(["read-only", "ask", "auto-review", "full-access"])),
        ]),
        .init(title: "Remote access", settings: [
            .init(key: "host.displayName", title: "Machine name", control: .text),
            .init(key: "remote.enabled", title: "Remote connections", control: .toggle),
            .init(key: "remote.transport", title: "Transport", control: .choices(["local", "lan", "tailscale", "relay"])),
            .init(key: "remote.agentAccess", title: "Other machines' agents", control: .choices(["off", "read", "operate"])),
            .init(key: "remote.relayUrl", title: "Relay address", control: .text),
        ]),
        .init(title: "Storage", settings: [
            .init(key: "storage.scheduledCleanup", title: "Scheduled cleanup", control: .toggle),
            .init(key: "storage.retentionDays", title: "Keep inactive data (days)", control: .number),
            .init(key: "logs.maxBytes", title: "Log limit (bytes)", control: .number),
        ]),
        .init(title: "Browser and computer", settings: [
            .init(key: "browser.backend", title: "Browser", control: .choices(["auto", "embedded", "headless"])),
            .init(key: "browser.backendLoss", title: "When browser disconnects", control: .choices(["pause", "headless"])),
            .init(key: "browser.profile", title: "Browser data", control: .choices(["persistent", "ephemeral"])),
            .init(key: "browser.profileScope", title: "Browser profile", control: .choices(["global", "project", "thread"])),
            .init(key: "browser.downloadDir", title: "Download folder on machine", control: .text),
            .init(key: "browser.userChrome.storageReads", title: "Agents can read Chrome storage", control: .toggle),
        ]),
        .init(title: "Generation", settings: [
            .init(key: "generation.autoDraftCommits", title: "Draft commit messages automatically", control: .toggle),
            .init(key: "automations.enabled", title: "Run automations", control: .toggle),
        ]),
    ]
}
private struct SettingsReply: Decodable {
    struct Entry: Decodable { let key: String; let value: ServiceValue; let provenance: String }
    struct Diagnostic: Decodable { let message: String }
    let ok: Bool
    let entries: [Entry]
    let diagnostics: [Diagnostic]
}
struct RemoteSettingsView: View {
    let model: ClientModel
    let category: RemoteSettingsCategory
    var body: some View {
        List {
            Section {
                ForEach(category.settings) { setting in RemoteSettingRow(model: model, setting: setting) }
            } header: { SettingsHeader(category.title, note: "Saved on this machine. A thread or project can override these defaults.") }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle(category.title).navigationBarTitleDisplayMode(.inline)
    }
}
private struct RemoteSettingRow: View {
    let model: ClientModel
    let setting: RemoteSetting
    @State private var value: ServiceValue?
    @State private var words = ""
    @State private var entries: [String] = []
    @State private var saving = false
    @State private var problem: String?
    var body: some View {
        VStack(alignment: .leading) {
            if let value {
                switch setting.control {
                case .toggle:
                    Toggle(isOn: Binding(get: { if case .bool(let on) = value { on } else { false } }, set: { save(.bool($0)) })) {
                        SettingsRow(title: setting.title) { EmptyView() }
                    }
                case .choices(let choices):
                    SettingsRow(title: setting.title) {
                        Picker(setting.title, selection: Binding(get: { words }, set: { save(.string($0)) })) {
                            ForEach(choices, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                        }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                    }
                case .stringList:
                    Text(setting.title).foregroundStyle(AceTheme.Colours.mutedForeground)
                    ForEach(entries.indices, id: \.self) { index in
                        HStack {
                            TextField("App name or bundle ID", text: Binding(get: { entries.indices.contains(index) ? entries[index] : "" }, set: { value in if entries.indices.contains(index) { entries[index] = value } }))
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button { entries.remove(at: index) } label: { Image(systemName: "minus.circle") }.accessibilityLabel("Remove app")
                        }
                    }
                    Button("Add app") { entries.append("") }.disabled(entries.count >= 200)
                    Button("Save") { save(.array(entries.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(ServiceValue.string))) }
                    Text("Password managers, terminals and ace itself are always blocked.").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
                case .text, .number:
                    TextField(setting.title, text: $words, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { saveWords() }
                    if changed { Button("Save", action: saveWords) }
                }
            } else if problem == nil { ProgressView(setting.title) }
            ServiceProblem(message: problem)
            if problem != nil { Button("Retry") { Task { await read() } } }
        }
        .disabled(saving || !model.canOperate)
        .accessibilityIdentifier("setting.\(setting.key)")
        .task { await read() }
    }
    private var changed: Bool { text(value) != words }
    private func text(_ value: ServiceValue?) -> String {
        switch value { case .string(let text): text; case .number(let number): String(format: "%.0f", number); default: "" }
    }
    private func read() async {
        do {
            let reply = try await model.service(["type": "settings.get", "key": setting.key, "scope": [:]], as: SettingsReply.self)
            try apply(reply)
        } catch { problem = error.localizedDescription }
    }
    private func saveWords() {
        if case .number = setting.control {
            guard let number = Double(words), number.isFinite else { problem = "Enter a number"; return }
            save(.number(number))
        } else { save(.string(words)) }
    }
    private func save(_ next: ServiceValue) {
        guard model.canOperate else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let encoded = try JSONEncoder().encode(next)
                let scalar = try JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed])
                let reply = try await model.service(["type": "settings.set", "key": setting.key, "value": scalar, "layer": ["kind": "global"]], as: SettingsReply.self)
                try apply(reply)
            } catch { problem = error.localizedDescription }
        }
    }
    private func apply(_ reply: SettingsReply) throws {
        guard reply.ok, let entry = reply.entries.first(where: { $0.key == setting.key }) else {
            throw ServiceFailure(message: reply.diagnostics.first?.message ?? "This setting couldn't be saved.")
        }
        value = entry.value; words = text(entry.value); problem = nil
        if case .array(let values) = entry.value { entries = values.compactMap { if case .string(let text) = $0 { text } else { nil } } }
    }
}
