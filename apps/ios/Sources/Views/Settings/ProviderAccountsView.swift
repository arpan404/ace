import SwiftUI

/// One account as the bridge shapes it (`accountRow` in `bridge/settings-accounts.ts`).
struct AccountRowData: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let signedInAs: String?
    let isDefault: Bool
    let state: String
    let tone: String
    let needsSignIn: Bool
    let method: String?
    let badge: AccountBadgeLook
    let typedBadge: String
    let canMakeDefault: Bool
    let removable: Bool
    let canDeleteFiles: Bool
    let removeMessage: String
}
/// One way to add or sign in an account (`accountWays`).
struct AccountWay: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let signIn: String?
    let cloud: Bool
    let next: String
    func payload(project: String = "", location: String = "") -> [String: Any] {
        var value: [String: Any] = ["project": project, "location": location]
        if let signIn { value["signIn"] = signIn }
        return value
    }
}
struct AccountsScreenData: Decodable, Equatable {
    let name: String
    let accounts: [AccountRowData]
    let ways: [AccountWay]
    let reauth: [AccountWay]
    /// "Add an API key in ace on studio." Keys are never taken on the phone (ADR 0002).
    let apiKey: String?
}
private struct AccountsAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let screen: AccountsScreenData?
}
/// A management answer that carries nothing but whether it worked.
struct PlainAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
}

/// A provider's accounts, as iOS lists accounts: one row each with its badge, name and state,
/// its actions in the row's ⋯ menu (and Edit and Remove on a swipe), then the one Add account row.
/// An account that needs signing in says so with a Sign in button on its row.
struct ProviderAccountsView: View {
    let model: ClientModel
    let provider: String
    let name: String
    @State private var screen: AccountsScreenData?
    @State private var problem: String?
    @State private var busy = false
    @State private var editing: AccountRowData?
    @State private var removing: AccountRowData?
    @State private var adding = false
    @State private var signingIn: AccountSignInTarget?
    @State private var changed = 0
    var body: some View {
        List {
            if let problem {
                ProblemRow(problem, id: "accounts.problem") { Task { await read() } }
            }
            Group {
                if let screen {
                    Section {
                        ForEach(screen.accounts) { account in
                            ProviderAccountRow(account: account, ways: screen.reauth, canOperate: model.canOperate,
                                               signIn: { way in signingIn = AccountSignInTarget(account: account, way: way) },
                                               makeDefault: { act(account, "setDefault") },
                                               edit: { editing = account },
                                               remove: { removing = account })
                        }
                        if model.canOperate {
                            Button { adding = true } label: { AddRow("Add account") }
                                .accessibilityIdentifier("accounts.add")
                        }
                    } footer: {
                        let lines = [screen.accounts.isEmpty ? "No accounts yet." : nil, screen.apiKey].compactMap { $0 }
                        if !lines.isEmpty { Text(lines.joined(separator: " ")) }
                    }
                } else if problem == nil {
                    Section { ForEach(0..<2, id: \.self) { _ in placeholder } }.redacted(reason: .placeholder)
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.default, value: screen)
        .disabled(busy)
        .navigationTitle("\(name) accounts").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }.refreshable { await read() }
        .sensoryFeedback(.success, trigger: changed)
        .sheet(item: $editing) { account in
            NavigationStack { AccountBadgeEditor(model: model, provider: provider, account: account) { Task { await read() } } }
        }
        .sheet(isPresented: $adding, onDismiss: { Task { await read() } }) {
            NavigationStack { AddAccountView(model: model, provider: provider, name: screen?.name ?? name, ways: screen?.ways ?? []) }
        }
        .sheet(item: $signingIn, onDismiss: { Task { await read() } }) { target in
            NavigationStack { AccountSignInSheet(model: model, provider: provider, name: name, target: target) }
        }
        .confirmationDialog(removing.map { "Remove \($0.label)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { account in
            Button("Remove account", role: .destructive) { remove(account, deleteFiles: false) }
            if account.canDeleteFiles {
                Button("Remove and delete its files", role: .destructive) { remove(account, deleteFiles: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { account in
            Text(account.canDeleteFiles ? "\(account.removeMessage) Deleting its files also erases the account's folder on the machine." : account.removeMessage)
        }
    }
    private var placeholder: some View {
        HStack(spacing: AceDesign.Space.row) { Circle().frame(width: AceDesign.Size.avatar, height: AceDesign.Size.avatar); Text("Account name"); Spacer(); Text("Signed in") }
    }
    private func act(_ account: AccountRowData, _ action: String) {
        busy = true; problem = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.manage(["type": "accounts.screen.act", "provider": provider, "instanceId": account.id, "action": action], as: PlainAnswer.self)
                changed += 1
                await read()
                model.refreshMachine()
            } catch { problem = error.localizedDescription }
        }
    }
    private func remove(_ account: AccountRowData, deleteFiles: Bool) { act(account, deleteFiles ? "removeWithFiles" : "remove") }
    private func read() async {
        do {
            let answer = try await model.manage(["type": "accounts.screen", "provider": provider], as: AccountsAnswer.self)
            screen = answer.screen; problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
