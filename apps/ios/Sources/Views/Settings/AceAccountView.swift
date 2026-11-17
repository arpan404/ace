import AuthenticationServices
import SwiftUI

/// Profile, as an iOS account page: the person, then their account's machines, a year of their
/// agents' work, Sign out, and the legal pages. The words follow web's Profile.
struct AceAccountView: View {
    /// Nil for the debug fixture, which has no account machines.
    var machines: MachinesModel?
    /// The machines this phone reaches, whose year of work the page adds up.
    var inbox: MachineInbox?
    /// The app's account (the header's avatar shows the same), else this page's own.
    @Environment(AceAccountModel.self) private var shared: AceAccountModel?
    @State private var own = AceAccountModel()
    private var model: AceAccountModel { shared ?? own }
    @State private var forgetting: AceMachine?
    @State private var signingOut = false
    @State private var notice: ProblemNotice?
    @State private var browserProblem: String?
    /// The year of work over every machine (`ProfileReads`), and why it couldn't be read.
    @State private var activity: ProfileReport?
    @State private var activityProblem: String?
    @State private var activityRead = 0
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    var body: some View {
        accountList
        .insetGroupedList()
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.restore() }
        // Again on Retry, and when a machine attaches, connects or drops.
        .task(id: activityKey) { await readActivity() }
        .refreshable {
            await machines?.refreshAccount()
            await readActivity()
        }
        // Signing in or out changes which machines this phone reaches through the account.
        .onChange(of: model.account?.id) { _, _ in browserProblem = nil; Task { await machines?.refreshAccount() } }
        .onChange(of: model.login?.loginUrl) { _, url in if let url { Task { await authenticate(url) } } }
        .onDisappear { model.cancel() }
        .confirmationDialog("Forget \(forgetting.map(Self.name) ?? "machine")?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                            titleVisibility: .visible, presenting: forgetting) { machine in
            Button("Forget", role: .destructive) {
                Task { notice = await machines?.forgetAccountMachine(machine.hostId) }
            }.accessibilityIdentifier("account.machine.forget.confirm")
        } message: { _ in Text("It comes back when it signs in again.") }
        // Web's sign-out question (`accountSignOutQuestion`).
        .confirmationDialog("Sign out?", isPresented: $signingOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                .accessibilityIdentifier("account.signOut.confirm")
        } message: { Text("Your threads and drafts stay on this device.") }
        .alert(notice?.message ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        }
    }

    private var accountList: some View {
        List {
            person
            if let error = model.error { Section { ServiceProblem(message: error) }.insetRowBackground() }
            browserFailure
            if model.account == nil { signIn }
            if model.account != nil, let listed { accountMachines(listed) }
            if let inbox, !inbox.sessions.isEmpty {
                ProfileActivitySections(report: activity, problem: activityProblem) {
                    activityProblem = nil
                    activityRead += 1
                }
            }
            if model.account != nil { signOut }
            legal
        }
    }

    /// The person, centred over the list: avatar, name, and the account's email or its state.
    private var person: some View {
        Section {
            VStack(spacing: AceDesign.Space.related) {
                // The same disc as the header's avatar.
                AccountAvatar(name: model.account?.name ?? "", picture: model.picture, size: AceDesign.Size.profileAvatar)
                VStack(spacing: AceDesign.Space.tight) {
                    Text(title).font(AceDesign.Typeface.body).fontWeight(AceDesign.Typeface.strong)
                    if let line {
                        Text(line).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.person")
            .listRowBackground(Color.clear)
        }
    }

    private var title: String {
        guard let account = model.account else { return "You" }
        return account.name.isEmpty ? account.email : account.name
    }

    /// The email under the name (unless it is the name), else where signing in stands.
    private var line: String? {
        if let account = model.account { return account.name.isEmpty ? nil : account.email }
        return model.login == nil ? "Not signed in" : "Finishing sign-in in your browser"
    }

    private var signIn: some View {
        Section {
            if model.login != nil {
                Button("Cancel") { model.cancel() }
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("account.signIn.cancel")
            } else {
                Button("Sign in") { model.signIn() }
                    .fontWeight(AceDesign.Typeface.strong)
                    .frame(maxWidth: .infinity)
                    .disabled(!model.configured || model.busy)
                    .accessibilityIdentifier("account.signIn")
            }
        }
        .insetRowBackground()
    }

    private var signOut: some View {
        Section {
            Button("Sign out", role: .destructive) { signingOut = true }
                .frame(maxWidth: .infinity)
                .disabled(model.busy)
                .accessibilityIdentifier("account.signOut")
        }
        .insetRowBackground()
    }

    /// The same pages web's Profile links to, opened in the system browser.
    private var legal: some View {
        Section {
            ForEach(Self.legalPages, id: \.id) { page in
                if let url = URL(string: page.url) {
                    Link(page.title, destination: url).accessibilityIdentifier("account.legal.\(page.id)")
                }
            }
        }
        .insetRowBackground()
    }

    private static let legalPages = [
        (id: "terms", title: "Terms of service", url: "https://acehq.dev/terms-of-service"),
        (id: "privacy", title: "Privacy policy", url: "https://acehq.dev/privacy-policy"),
    ]

    @ViewBuilder private var browserFailure: some View {
        if let problem = browserProblem {
            Section {
                ServiceProblem(message: problem)
                Button("Try again", action: retryBrowser).buttonStyle(.textAction())
            }.insetRowBackground()
        }
    }

    private var activityKey: String {
        let machines = (inbox?.sessions ?? []).map { "\($0.hostId):\($0.client.connection)" }.joined(separator: ",")
        return "\(activityRead)|\(machines)"
    }

    private func readActivity() async {
        guard let inbox, !inbox.sessions.isEmpty else { return }
        let reads = ProfileReads(machines: inbox.sessions, name: inbox.name)
        let problem = await reads.report { activity = $0 }
        if activity == nil { activityProblem = problem }
    }

    private func retryBrowser() {
        if let url = model.login?.loginUrl { Task { await authenticate(url) } }
        else { browserProblem = nil; model.signIn() }
    }

    /// Sign-in in a browser sheet that closes itself when the backend sends it back to
    /// `ace://account/signed-in`. The session arrives through the model's claim either way.
    private func authenticate(_ url: URL) async {
        browserProblem = nil
        do {
            let returned = try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: AceLink.scheme)
            model.returned(returned)
        } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
            // The person closed the sheet before WorkOS finished: stop waiting for this sign-in.
            if model.account == nil { model.cancel() }
        } catch { browserProblem = error.localizedDescription }
    }

    /// The account's machines; `--spike-account`'s when there is no machines model (the fixture).
    private var listed: [AceMachine]? {
        machines?.accountMachines ?? (SpikeConfiguration.account ? SpikeConfiguration.accountMachines(now: Date().timeIntervalSince1970 * 1000) : nil)
    }

    /// Web's "Machines on your account". Forget is the row's swipe and long-press action.
    @ViewBuilder private func accountMachines(_ listed: [AceMachine]) -> some View {
        Section {
            if listed.isEmpty {
                Text("No machines yet. Sign in to ace on a computer.")
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("account.machines.empty")
            }
            ForEach(listed) { machine in
                InsetRow(systemImage: Self.symbol(machine.platform), title: Self.name(machine), subtitle: subtitle(machine)) { EmptyView() }
                    .swipeActions(edge: .trailing) { forget(machine) }
                    .contextMenu { forget(machine) }
                    .accessibilityIdentifier("account.machine.\(machine.hostId)")
            }
        } header: {
            InsetHeader("Machines on your account")
        }
        .insetRowBackground()
    }

    private func forget(_ machine: AceMachine) -> some View {
        Button("Forget") { forgetting = machine }
            .tint(AceDesign.Ink.destructive)
            .accessibilityIdentifier("account.machine.forget.\(machine.hostId)")
    }

    private static func name(_ machine: AceMachine) -> String { machine.name.isEmpty ? "Machine" : machine.name }

    /// "Seen 4 min. ago"; "Paired" first when this phone is also paired with it.
    private func subtitle(_ machine: AceMachine) -> String? {
        let paired = machines?.entry(machine.hostId).map { !$0.isAccountMachine } ?? false
        var parts = paired ? ["Paired"] : []
        if machine.lastSeenAt > 0 {
            let seen = Date(timeIntervalSince1970: machine.lastSeenAt / 1000)
            parts.append((paired ? "seen " : "Seen ") + seen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func symbol(_ platform: String) -> String {
        switch platform {
        case "darwin", "macos": "laptopcomputer"
        case "win32", "windows": "pc"
        default: "desktopcomputer"
        }
    }
}
