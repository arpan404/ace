import SwiftUI

/// A sign-in the daemon started for an account, with the account it belongs to.
struct StartedSignIn: Equatable {
    let progress: LoginProgress
    let instance: String?
    static func == (left: StartedSignIn, right: StartedSignIn) -> Bool {
        left.progress.session == right.progress.session && left.progress.state == right.progress.state
    }
}
/// `accounts.screen.add` and `.reauth`: the sign-in they started.
private struct SignInAnswer: ManageAnswer {
    private struct Owner: Decodable { let instance: String? }
    private enum Keys: String, CodingKey { case ok, problem, progress }
    let ok: Bool
    let problem: String?
    let started: StartedSignIn?
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        ok = try box.decode(Bool.self, forKey: .ok)
        problem = try box.decodeIfPresent(String.self, forKey: .problem)
        let progress = try box.decodeIfPresent(LoginProgress.self, forKey: .progress)
        let owner = try box.decodeIfPresent(Owner.self, forKey: .progress)
        started = progress.map { StartedSignIn(progress: $0, instance: owner?.instance) }
    }
}

/// `accounts.screen.key`: the account a pasted key added.
private struct KeyAnswer: ManageAnswer {
    let ok: Bool
    let problem: String?
    let instance: String?
}

/// How a new account signs in: one of the daemon's sign-in ways, or a pasted API key. Pure.
enum AddAccountChoice: Identifiable, Equatable {
    case signIn(AccountWay)
    case key(KeyWay)
    var id: String {
        switch self {
        case .signIn(let way): "signIn/\(way.id)"
        case .key(let way): "key/\(way.id)"
        }
    }
    var label: String {
        switch self {
        case .signIn(let way): way.label
        case .key(let way): way.label
        }
    }
    var next: String {
        switch self {
        case .signIn(let way): way.next
        case .key(let way): way.next
        }
    }
    var keyWay: KeyWay? { if case .key(let way) = self { way } else { nil } }
    var signInWay: AccountWay? { if case .signIn(let way) = self { way } else { nil } }
    /// The sign-in ways first, as before, then each key way the daemon offers.
    static func all(ways: [AccountWay], keys: [KeyWay]) -> [AddAccountChoice] {
        ways.map(AddAccountChoice.signIn) + keys.map(AddAccountChoice.key)
    }
    /// The bridge request that hands `key` over for a new account (`bridge/provider-key.ts`).
    static func keyRequest(provider: String, label: String, letters: String, way: KeyWay, key: String) -> [String: Any] {
        var payload: [String: Any] = [
            "type": "accounts.screen.key", "provider": provider, "label": label,
            "shortLabel": letters, "apiKey": key,
        ]
        if let upstream = way.upstream { payload["upstream"] = upstream }
        return payload
    }
}

/// Name a new account, give it a badge, choose how it signs in, then sign in.
struct AddAccountView: View {
    let model: ClientModel
    let provider: String
    let name: String
    let ways: [AccountWay]
    var keyWays: [KeyWay] = []
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var draft = BadgeDraft()
    @State private var badgeProblem: String?
    @State private var way: AddAccountChoice?
    /// The pasted key, only until it is handed over or the sheet goes; never kept anywhere else.
    @State private var key = ""
    /// The account a key added, for its badge once it exists.
    @State private var added: String?
    @State private var project = ""
    @State private var location = "global"
    @State private var problem: String?
    @State private var busy = false
    @State private var started: StartedSignIn?
    var body: some View {
        Group {
            if let started {
                AccountSignInFlow(model: model, provider: provider, name: name, started: started)
                    .transition(.opacity)
                    .safeAreaInset(edge: .bottom) {
                        if let problem {
                            ProblemRow(problem, id: "accounts.add.problem", disabled: busy) { Task { await finish() } }
                                .padding(.vertical, AceDesign.Space.related).background(AceDesign.Surface.background)
                        }
                    }
            } else { form.transition(.opacity) }
        }
        .animation(.default, value: started)
        .navigationTitle(started == nil ? "Add \(name) account" : label).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Once a key has added the account, only its badge is left: Add again would add another.
            if started == nil && added == nil {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Adding…" : "Add") { Task { await add() } }
                        .disabled(busy || badgeProblem != nil || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canOperate
                                  || (way?.keyWay != nil && key.isEmpty))
                }
            } else {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { Task { await finish() } }.disabled(busy) }
            }
        }
        .sensoryFeedback(.success, trigger: started != nil)
        .onAppear { if way == nil { way = choices.first } }
        .onDisappear { key = "" }
    }
    private var form: some View {
        Form {
            Group {
                Section { TextField("Work", text: $label).accessibilityLabel("Account name") } header: { InsetHeader("Name") }
                BadgeFields(model: model, name: label.isEmpty ? "Work" : label, draft: $draft, problem: $badgeProblem)
                Section {
                    ForEach(choices) { option in
                        Button { withAnimation { way = option } } label: {
                            HStack {
                                Text(option.label).foregroundStyle(AceDesign.Ink.primary)
                                Spacer()
                                if way?.id == option.id { AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .body).foregroundStyle(AceDesign.Ink.action) }
                            }
                            .frame(minHeight: AceDesign.Size.tap).contentShape(Rectangle())
                        }
                        .accessibilityAddTraits(way?.id == option.id ? .isSelected : [])
                    }
                    if way?.signInWay?.cloud == true {
                        TextField("Google Cloud project ID", text: $project).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Location", text: $location).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } header: { InsetHeader("Sign in with") } footer: { if let way { Text(way.next) } }
                if way?.keyWay != nil {
                    Section {
                        SecureField("Paste the key", text: $key)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                            .accessibilityIdentifier("accounts.add.key")
                    } header: { InsetHeader("API key") }
                }
            }
            .insetRowBackground()
            if let problem { ProblemRow(problem, id: "accounts.add.problem") }
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: way)
    }
    private var choices: [AddAccountChoice] { AddAccountChoice.all(ways: ways, keys: keyWays) }
    private func add() async {
        guard let way else { return }
        busy = true; problem = nil
        defer { busy = false }
        if let keyWay = way.keyWay {
            // Out of the field before it goes: a failure asks for the key again.
            let entry = key; key = ""
            do {
                let answer = try await model.manage(
                    AddAccountChoice.keyRequest(provider: provider, label: label, letters: draft.letters, way: keyWay, key: entry),
                    as: KeyAnswer.self, timeout: .seconds(130))
                added = answer.instance
                busy = false
                await finish()
            } catch { problem = error.localizedDescription }
            return
        }
        guard let signIn = way.signInWay else { return }
        do {
            let answer = try await model.manage([
                "type": "accounts.screen.add", "provider": provider, "label": label,
                "shortLabel": draft.letters, "way": signIn.payload(project: project, location: location),
            ], as: SignInAnswer.self)
            guard let next = answer.started else { dismiss(); return }
            started = next
        } catch { problem = error.localizedDescription }
    }
    /// The icon and colour join once the account exists; letters went with the add.
    private func finish() async {
        guard !busy else { return }
        busy = true; problem = nil
        defer { busy = false }
        if let instance = started?.instance ?? added, draft.icon != nil || draft.colour != "neutral" {
            var payload = draft.payload
            payload["type"] = "accounts.screen.rename"; payload["provider"] = provider
            payload["instanceId"] = instance; payload["label"] = label
            do { _ = try await model.manage(payload, as: PlainAnswer.self) }
            catch { problem = error.localizedDescription; return }
        }
        model.refreshMachine()
        dismiss()
    }
}

/// Signing an existing account in again one particular way.
struct AccountSignInTarget: Identifiable {
    let account: AccountRowData
    let way: AccountWay
    var id: String { "\(account.id)/\(way.id)" }
}

/// Sign an account in again: a cloud sign-in asks for its project first, then the sign-in runs.
struct AccountSignInSheet: View {
    let model: ClientModel
    let provider: String
    let name: String
    let target: AccountSignInTarget
    @Environment(\.dismiss) private var dismiss
    @State private var project = ""
    @State private var location = "global"
    @State private var problem: String?
    @State private var busy = false
    @State private var started: StartedSignIn?
    var body: some View {
        Group {
            if let started {
                AccountSignInFlow(model: model, provider: provider, name: target.account.label, started: started).transition(.opacity)
            } else {
                Form {
                    Group {
                        if target.way.cloud {
                            Section {
                                TextField("Google Cloud project ID", text: $project).textInputAutocapitalization(.never).autocorrectionDisabled()
                                TextField("Location", text: $location).textInputAutocapitalization(.never).autocorrectionDisabled()
                            } header: { InsetHeader(target.way.label) } footer: { Text(target.way.next) }
                            Button("Continue") { Task { await start() } }.buttonStyle(.rowAction).disabled(busy)
                        } else if busy { SkeletonRows(count: 1, label: "Starting sign-in").listRowInsets(EdgeInsets()) }
                    }
                    .insetRowBackground()
                    if let problem { ProblemRow(problem, id: "accounts.signIn.problem", disabled: busy) { Task { await start() } } }
                }
                .insetGroupedList()
                .transition(.opacity)
            }
        }
        .smoothChange(started)
        .navigationTitle(target.account.label).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.refreshMachine(); dismiss() } } }
        .task { if !target.way.cloud { await start() } }
    }
    private func start() async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            let answer = try await model.manage([
                "type": "accounts.screen.reauth", "provider": provider, "instanceId": target.account.id,
                "way": target.way.payload(project: project, location: location),
            ], as: SignInAnswer.self)
            started = answer.started
            if answer.started == nil { dismiss() }
        } catch { problem = error.localizedDescription }
    }
}

/// A started sign-in, continued in the provider's sign-in page. A pasted API key never comes
/// here: it goes by `accounts.screen.key` over the relay's `provider_auth` channel (ADR 0002).
struct AccountSignInFlow: View {
    let model: ClientModel
    let provider: String
    let name: String
    let started: StartedSignIn
    var body: some View {
        ProviderSignInView(model: model, provider: provider, name: name, instance: started.instance, initial: started.progress)
    }
}
