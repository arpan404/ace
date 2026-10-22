import SwiftUI

private struct NativeProviderAccount: Decodable, Identifiable {
    let id: String
    let label: String
    let signedInAs: String?
    let isDefault: Bool?
    let status: String
}
private struct NativeAccountsReply: Decodable {
    struct Result: Decodable {
        let ok: Bool
        let accounts: [NativeProviderAccount]?
        let progress: LoginProgress?
        let error: String?
    }
    let result: Result
}

/// A provider's accounts on the machine: one section per account, headed by its name and who it
/// is signed in as, with its sign-in and management verbs as rows.
struct ProviderAccountsView: View {
    let model: ClientModel
    let provider: String
    let name: String
    @State private var accounts: [NativeProviderAccount] = []
    @State private var problem: String?
    @State private var busy = false
    @State private var label = ""
    @State private var renaming: NativeProviderAccount?
    @State private var removing: NativeProviderAccount?
    @State private var signingIn: LoginProgress?
    var body: some View {
        List {
            ForEach(accounts) { account in
                Section {
                    SettingsRow("Status", value: account.isDefault == true ? "Default" : account.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        .accessibilityElement(children: .combine)
                    if model.canOperate {
                        NavigationLink { ProviderSignInView(model: model, provider: provider, name: account.label, instance: account.id) } label: {
                            SettingsRow("Sign in")
                        }
                        if account.isDefault != true {
                            Button { perform("setDefault", account: account) } label: { SettingsActionLabel(title: "Use by default") }
                                .buttonStyle(.plain)
                        }
                        Button { label = account.label; renaming = account } label: { SettingsActionLabel(title: "Rename") }
                            .buttonStyle(.plain)
                        Button(role: .destructive) { removing = account } label: {
                            Text("Remove account").aceFont(SettingsStyle.label, relativeTo: .body)
                                .foregroundStyle(AceTheme.StatusText.failed).frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                } header: { SettingsHeader(account.label, note: account.signedInAs) }
                .settingsRow()
            }
            if model.canOperate {
                Section {
                    Button {
                        Task { await request(["type": "provider.accounts.add", "provider": provider, "method": "login"]) }
                    } label: {
                        SettingsActionLabel(title: "Add account", icon: .userPlus)
                    }
                    .buttonStyle(.plain)
                }
                .settingsRow()
            }
            if let problem {
                Section {
                    ServiceProblem(message: problem)
                    Button { Task { await read() } } label: { SettingsActionLabel(title: "Retry") }
                        .buttonStyle(.plain)
                }
                .settingsRow()
            }
        }
        .settingsList()
        .disabled(busy)
        .navigationTitle("\(name) accounts").navigationBarTitleDisplayMode(.inline)
        .task { await read() }.refreshable { await read() }
        .alert("Rename account", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $label)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") { if let account = renaming { perform("rename", account: account, extra: ["label": label]) }; renaming = nil }
                .disabled(label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Remove account?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove account", role: .destructive) { if let account = removing { perform("remove", account: account, extra: ["confirm": true, "deleteHome": false]) }; removing = nil }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: { Text("Existing conversations stay. The account's files on your computer are kept.") }
        .sheet(item: Binding(get: { signingIn.map(LoginTarget.init) }, set: { signingIn = $0?.progress })) { target in
            NavigationStack {
                ProviderSignInView(model: model, provider: provider, name: name, initial: target.progress)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { signingIn = nil; Task { await read() } } } }
            }
        }
    }
    private struct LoginTarget: Identifiable { let progress: LoginProgress; var id: String { progress.session } }
    private func perform(_ operation: String, account: NativeProviderAccount, extra: [String: Any] = [:]) {
        var payload = extra
        payload["type"] = "provider.accounts.\(operation)"; payload["provider"] = provider; payload["instanceId"] = account.id
        Task { await request(payload) }
    }
    private func read() async { await request(["type": "provider.accounts.list", "provider": provider]) }
    private func request(_ payload: [String: Any]) async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            let reply = try await model.service(payload, as: NativeAccountsReply.self)
            guard reply.result.ok else { throw ServiceFailure(message: "Couldn't update accounts: \(reply.result.error ?? "unavailable"). Check the machine connection and account permissions.") }
            accounts = reply.result.accounts ?? []; signingIn = reply.result.progress
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

