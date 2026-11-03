import SwiftUI

struct AceAccountView: View {
    /// Nil for the debug fixture, which has no account machines.
    var machines: MachinesModel?
    @State private var model = AceAccountModel()
    @State private var forgetting: AceMachine?
    @State private var notice: ProblemNotice?
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.account.map { $0.name.isEmpty ? $0.email : $0.name } ?? "Your profile")
                            .fontWeight(.medium)
                        Text(model.account?.email ?? (model.login == nil ? "Not signed in" : "Complete sign-in in your browser"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
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
            if let error = model.error { Section { ServiceProblem(message: error) }.insetRowBackground() }
            if model.account != nil, let machines { accountMachines(machines) }
        }
        .insetGroupedList()
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.restore() }
        .refreshable { await machines?.refreshAccount() }
        // Signing in or out changes which machines this phone reaches through the account.
        .onChange(of: model.account?.id) { _, _ in Task { await machines?.refreshAccount() } }
        .onChange(of: model.login?.loginUrl) { _, url in if let url { openURL(url) } }
        .onDisappear { model.cancel() }
        .confirmationDialog("Forget \(forgetting?.name ?? "machine")?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                            titleVisibility: .visible, presenting: forgetting) { machine in
            Button("Forget \(machine.name)", role: .destructive) {
                Task { notice = await machines?.forgetAccountMachine(machine.hostId) }
            }.accessibilityIdentifier("account.machine.forget.confirm")
        } message: { _ in Text("It leaves your ace account's list on every device. It comes back when it signs in to ace again.") }
        .alert("Couldn't forget", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice?.message ?? "") }
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
        var parts = [paired ? "Paired" : "Through your account"]
        if machine.lastSeenAt > 0 {
            let seen = Date(timeIntervalSince1970: machine.lastSeenAt / 1000)
            parts.append("seen " + seen.formatted(.relative(presentation: .named)))
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
