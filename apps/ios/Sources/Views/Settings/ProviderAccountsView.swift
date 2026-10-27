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
    let method: String
    let upstream: String?
    let signIn: String?
    let cloud: Bool
    let next: String
    func payload(project: String = "", location: String = "") -> [String: Any] {
        var value: [String: Any] = ["method": method, "project": project, "location": location]
        if let upstream { value["upstream"] = upstream }
        if let signIn { value["signIn"] = signIn }
        return value
    }
}
struct AccountsScreenData: Decodable, Equatable {
    let name: String
    let accounts: [AccountRowData]
    let ways: [AccountWay]
    let reauth: [AccountWay]
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

/// A provider's accounts: each one's badge, state and actions as visible buttons, then Add
/// account with every way the daemon offers.
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        List {
            Group {
                if let screen {
                    ForEach(screen.accounts) { account in section(account, screen: screen) }
                    if model.canOperate {
                        Section {
                            Button("Add account") { adding = true }.frame(minHeight: 44)
                        } footer: { if screen.accounts.isEmpty { Text("No accounts yet.") } }
                    }
                } else if problem == nil {
                    Section { ForEach(0..<2, id: \.self) { _ in placeholder } }.redacted(reason: .placeholder)
                }
                if let problem {
                    Section {
                        ServiceProblem(message: problem)
                        Button("Retry") { Task { await read() } }
                    }
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: screen)
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
        HStack(spacing: AceTheme.Spacing.md) { Circle().frame(width: 26, height: 26); Text("Account name"); Spacer(); Text("Signed in") }
    }
    @ViewBuilder private func section(_ account: AccountRowData, screen: AccountsScreenData) -> some View {
        Section {
            HStack(spacing: AceTheme.Spacing.md) {
                AccountBadgeMark(look: account.badge)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(account.label).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                    let detail = [account.isDefault ? "Default" : nil, account.method, account.signedInAs].compactMap { $0 }.joined(separator: " · ")
                    if !detail.isEmpty {
                        Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                    }
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(account.state).aceFont(InsetStyle.value, relativeTo: .body)
                    .foregroundStyle(account.tone == "problem" ? AceTheme.StatusText.failed : account.needsSignIn ? AceTheme.StatusText.needsYou : AceTheme.Colours.mutedForeground)
                    .lineLimit(1)
            }
            .padding(.vertical, AceTheme.Spacing.xs)
            .accessibilityElement(children: .combine)
            if model.canOperate {
                signInButton(account, ways: screen.reauth)
                if account.canMakeDefault { Button("Use by default") { act(account, "setDefault") } }
                Button("Edit name and badge") { editing = account }
                if account.removable { Button("Remove account", role: .destructive) { removing = account } }
            }
        }
    }
    @ViewBuilder private func signInButton(_ account: AccountRowData, ways: [AccountWay]) -> some View {
        let title = account.needsSignIn ? "Sign in" : "Sign in again"
        if ways.count > 1 {
            Menu(title) {
                ForEach(ways) { way in Button(way.label) { signingIn = AccountSignInTarget(account: account, way: way) } }
            }
        } else if let way = ways.first {
            Button(title) { signingIn = AccountSignInTarget(account: account, way: way) }
        }
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
