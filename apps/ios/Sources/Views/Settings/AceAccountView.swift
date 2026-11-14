import AuthenticationServices
import SwiftUI

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
        .confirmationDialog("Forget \(forgetting?.name ?? "machine")?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                            titleVisibility: .visible, presenting: forgetting) { machine in
            Button("Forget \(machine.name)", role: .destructive) {
                Task { notice = await machines?.forgetAccountMachine(machine.hostId) }
            }.accessibilityIdentifier("account.machine.forget.confirm")
        } message: { _ in Text("It leaves your ace account's list on every device. It comes back when it signs in to ace again.") }
        .alert("Couldn't forget", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("Dismiss") { notice = nil }
        } message: { Text(notice?.message ?? "") }
    }

    private var accountList: some View {
        List {
            profileSection
            if let error = model.error { Section { ServiceProblem(message: error) }.insetRowBackground() }
            if let inbox, !inbox.sessions.isEmpty {
                ProfileActivitySections(report: activity, problem: activityProblem) {
                    activityProblem = nil
                    activityRead += 1
                }
            }
            browserFailure
            if model.account != nil, let machines { accountMachines(machines) }
            legal
        }
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

    private var profileSection: some View {
        Section {
            HStack(spacing: AceDesign.Space.row) {
                // The same disc as the header's avatar.
                AccountAvatar(name: model.account?.name ?? "", picture: model.picture, size: AceDesign.Size.tap)
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(model.account.map { $0.name.isEmpty ? $0.email : $0.name } ?? "Your profile")
                        .font(AceDesign.Typeface.body).fontWeight(AceDesign.Typeface.strong)
                    Text(model.account?.email ?? (model.login == nil ? "Not signed in" : "Complete sign-in in your browser"))
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                }
                Spacer()
                if model.account != nil {
                    Button("Sign out") { Task { await model.signOut() } }
                        .disabled(model.busy)
                } else if model.login != nil {
                    Button("Cancel") { model.cancel() }
                } else {
                    Button("Sign in") { model.signIn() }
                        .disabled(!model.configured || model.busy)
                }
            }
        }
        .insetRowBackground()
    }

    @ViewBuilder private var browserFailure: some View {
        if let problem = browserProblem {
            Section {
                ServiceProblem(message: problem)
                Button("Retry", action: retryBrowser).buttonStyle(.textAction())
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

    @ViewBuilder private func accountMachines(_ machines: MachinesModel) -> some View {
        Section {
            if machines.accountMachines.isEmpty {
                Text("No machines yet. Sign in to ace on a computer, or run ace login there.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityIdentifier("account.machines.empty")
            }
            ForEach(machines.accountMachines) { machine in
                InsetRow(systemImage: Self.symbol(machine.platform), title: machine.name.isEmpty ? "Machine" : machine.name,
                         subtitle: subtitle(machine, machines: machines)) {
                    Button("Forget") { forgetting = machine }
                        .buttonStyle(.borderless)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityIdentifier("account.machine.forget.\(machine.hostId)")
                }
                .accessibilityIdentifier("account.machine.\(machine.hostId)")
            }
        } header: {
            InsetHeader("Machines on this account")
        } footer: {
            Text("Every machine on your account opens from this phone. A machine with a machine code asks for it once.")
        }
        .insetRowBackground()
    }

    private func subtitle(_ machine: AceMachine, machines: MachinesModel) -> String {
        let paired = machines.entry(machine.hostId).map { !$0.isAccountMachine } ?? false
        var parts = [paired ? "Paired" : "Via account"]
        if machine.lastSeenAt > 0 {
            let seen = Date(timeIntervalSince1970: machine.lastSeenAt / 1000)
            parts.append("seen " + seen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
        }
        return parts.joined(separator: " · ")
    }
    static func symbol(_ platform: String) -> String {
        switch platform {
        case "darwin", "macos": "laptopcomputer"
        case "win32", "windows": "pc"
        default: "desktopcomputer"
        }
    }
}
