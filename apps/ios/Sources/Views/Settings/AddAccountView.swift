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

/// Name a new account, give it a badge, choose how it signs in, then sign in.
struct AddAccountView: View {
    let model: ClientModel
    let provider: String
    let name: String
    let ways: [AccountWay]
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var draft = BadgeDraft()
    @State private var badgeProblem: String?
    @State private var way: AccountWay?
    @State private var project = ""
    @State private var location = "global"
    @State private var problem: String?
    @State private var busy = false
    @State private var started: StartedSignIn?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Group {
            if let started {
                AccountSignInFlow(model: model, provider: provider, name: name, started: started)
                    .transition(.opacity)
            } else { form.transition(.opacity) }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: started)
        .navigationTitle(started == nil ? "Add \(name) account" : label).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if started == nil {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Adding…" : "Add") { Task { await add() } }
                        .disabled(busy || badgeProblem != nil || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canOperate)
                }
            } else {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { Task { await finish() } } }
            }
        }
        .sensoryFeedback(.success, trigger: started != nil)
        .onAppear { if way == nil { way = ways.first } }
    }
    private var form: some View {
        Form {
            Group {
                Section { TextField("Work", text: $label).accessibilityLabel("Account name") } header: { InsetHeader("Name") }
                BadgeFields(model: model, name: label.isEmpty ? "Work" : label, draft: $draft, problem: $badgeProblem)
                Section {
                    ForEach(ways) { option in
                        Button { withAnimation(.smooth(duration: 0.2)) { way = option } } label: {
                            HStack {
                                Text(option.label).foregroundStyle(AceTheme.Colours.foreground)
                                Spacer()
                                if way?.id == option.id { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
                            }
                            .frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .accessibilityAddTraits(way?.id == option.id ? .isSelected : [])
                    }
                    if way?.cloud == true {
                        TextField("Google Cloud project ID", text: $project).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Location", text: $location).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } header: { InsetHeader("Sign in with") } footer: { if let way { Text(way.next) } }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .sensoryFeedback(.selection, trigger: way)
    }
    private func add() async {
        guard let way else { return }
        busy = true; problem = nil
        defer { busy = false }
        do {
            let answer = try await model.manage([
                "type": "accounts.screen.add", "provider": provider, "label": label,
                "shortLabel": draft.letters, "way": way.payload(project: project, location: location),
            ], as: SignInAnswer.self)
            guard let next = answer.started else { dismiss(); return }
            started = next
        } catch { problem = error.localizedDescription }
    }
    /// The icon and colour join once the account exists; letters went with the add.
    private func finish() async {
        if let instance = started?.instance, draft.icon != nil || draft.colour != "neutral" {
            var payload = draft.payload
            payload["type"] = "accounts.screen.rename"; payload["provider"] = provider
            payload["instanceId"] = instance; payload["label"] = label
            _ = try? await model.manage(payload, as: PlainAnswer.self)
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
                            Button("Continue") { Task { await start() } }.disabled(busy)
                        } else if busy { HStack { Spacer(); ProgressView(); Spacer() } }
                        ServiceProblem(message: problem)
                    }
                    .insetRowBackground()
                }
                .insetGroupedList()
                .transition(.opacity)
            }
        }
        .animation(.smooth, value: started)
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

/// A started sign-in, continued in the provider's sign-in page. API keys are never entered on
/// the phone: ADR 0002 allows them only over the relay's `provider_auth` channel.
struct AccountSignInFlow: View {
    let model: ClientModel
    let provider: String
    let name: String
    let started: StartedSignIn
    var body: some View {
        ProviderSignInView(model: model, provider: provider, name: name, instance: started.instance, initial: started.progress)
    }
}
