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
                    LabeledContent(account.label, value: account.isDefault == true ? "Default" : account.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    if let identity = account.signedInAs { Text(identity).foregroundStyle(AceTheme.Colours.mutedForeground) }
                    if model.canOperate {
                        NavigationLink("Sign in") { ProviderSignInView(model: model, provider: provider, name: account.label, instance: account.id) }
                        if account.isDefault != true { Button("Use by default") { perform("setDefault", account: account) } }
                        Button("Rename") { label = account.label; renaming = account }
                        Button("Remove account", role: .destructive) { removing = account }
                    }
                }
            }
            Section {
                if model.canOperate {
                    Button("Add account", ace: .userPlus) {
                        Task { await request(["type": "provider.accounts.add", "provider": provider, "method": "login"]) }
                    }
                }
            }
            ServiceProblem(message: problem)
            if problem != nil { Button("Retry") { Task { await read() } } }
        }
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
