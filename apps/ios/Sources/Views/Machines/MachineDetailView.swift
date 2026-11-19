import SwiftUI

/// One paired computer: connection, access and address, the coding-agent CLIs it reports with
/// their sign-in and usage, its ace version and update, its own settings, then rename and remove. Words arrive from
/// `@ace/ui-core/mobile`.
struct MachineDetailView: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let hostId: String

    @Environment(\.dismiss) private var dismiss
    @State private var enteringCode = false
    @State private var code = ""

    private var client: ClientModel? { inbox.client(hostId) }

    var body: some View {
        let facts = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        List {
            if let machines, !facts.needsPairing { onSection(machines, facts: facts) }
            connectionSection(facts)
            providers
            if let client {
                MachineSoftwareSection(model: client, name: facts.name)
                fleetSection(client, facts: facts)
                hostSection(client)
            }
            MachineManageSection(inbox: inbox, machines: machines, hostId: hostId, name: facts.name) { dismiss() }
        }
        .insetGroupedList()
        .navigationTitle(facts.name).navigationBarTitleDisplayMode(.inline)
        .task(id: hostId) { client?.refreshMachine() }
        .refreshable { client?.refreshMachine() }
        // The sheet covers the inbox's own prompt, so the machine asks here too.
        .alert("Machine code for \(facts.name)", isPresented: $enteringCode) {
            SecureField("Machine code", text: $code).textContentType(.password).accessibilityIdentifier("machine.code.field")
            Button("Cancel", role: .cancel) { code = "" }
            Button("Open") { let typed = code; code = ""; client?.enterMachineCode(typed) }
        } message: { Text(client?.machineCodeAsk?.message(lockedUntil: client?.machineCodeLockedUntil) ?? "") }
    }

    private func onSection(_ machines: MachinesModel, facts: MachineFacts) -> some View {
        Section {
            Toggle("On this iPhone", isOn: Binding(get: { !machines.isOff(hostId) },
                                                  set: { on in Task { await machines.setOn(hostId, on) } }))
                .accessibilityIdentifier("machine.on")
        } footer: {
            Text(facts.off ? "\(facts.name) stays paired. Its threads and notifications are hidden on this iPhone until you turn it on."
                           : "Turn off to hide its threads and notifications on this iPhone. It stays paired.")
        }
        .insetRowBackground()
    }

    /// Connection, access, address and the desktop app, then Pause new work as the group's one
    /// action, so it never sits alone in a card of its own.
    private func connectionSection(_ facts: MachineFacts) -> some View {
        Section {
            LabeledContent("Connection") { StateLabel(status: facts.connection) }
                .accessibilityIdentifier("machine.connection")
            if !facts.connected && !facts.off {
                LabeledContent("Last seen", value: facts.lastSeen.map { $0.formatted(.relative(presentation: .named)) } ?? "Not yet")
            }
            if let readOnly = facts.readOnly {
                LabeledContent("Access", value: readOnly ? "View only" : "Full access").accessibilityIdentifier("machine.access")
            }
            if let address = facts.address {
                LabeledContent("Address") { Text(address).font(AceDesign.Typeface.code) }
            }
            if let update = client?.appUpdate, update.known { MachineAppUpdateRow(update: update) }
            problem(facts)
            if let client, client.admission?.known == true { MachineAdmissionRow(model: client) }
        }
        .insetRowBackground()
    }

    /// The machine code it asks for, or why this phone can't reach it, with its way out under it.
    @ViewBuilder private func problem(_ facts: MachineFacts) -> some View {
        if let client, let ask = client.machineCodeAsk {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                problemText(ask.message(lockedUntil: client.machineCodeLockedUntil), tone: AceTheme.StatusText.needsYou)
                if ask.canEnter {
                    Button("Enter code") { enteringCode = true }
                        .buttonStyle(.secondaryAction).accessibilityIdentifier("machine.code.enter")
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
        } else if let problem = facts.needsPairing ? nil : client?.problem {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                problemText(problem.message, tone: AceTheme.StatusText.failed)
                if problem.code == "unreachable" || problem.code == "offline" {
                    Button("Try again") { client?.retry() }.buttonStyle(.secondaryAction)
                        .accessibilityIdentifier("machine.retry")
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
        }
    }

    private func fleetSection(_ client: ClientModel, facts: MachineFacts) -> some View {
        Section {
            NavigationLink { MachineDevicesView(model: client, machine: facts.name) } label: {
                InsetRow("Devices", systemImage: "iphone.and.arrow.forward", subtitle: "Pair, review and revoke devices")
            }
            .accessibilityIdentifier("machine.devices")
            if client.canAdmin != false {
                NavigationLink { ConnectedAppsView(model: client, machine: facts.name) } label: {
                    InsetRow("Connected apps", systemImage: "app.connected.to.app.below.fill", subtitle: "Apps outside ace, such as claude.ai")
                }
                .accessibilityIdentifier("machine.connectedApps")
            }
            NavigationLink { MachineLinksView(inbox: inbox, hostId: hostId) } label: {
                InsetRow("Linked machines", systemImage: "point.3.connected.trianglepath.dotted", subtitle: "Machines its agents can reach")
            }
            .accessibilityIdentifier("machine.links")
        } header: { InsetHeader("Fleet") }
        .insetRowBackground()
    }

    private func hostSection(_ client: ClientModel) -> some View {
        Section {
            NavigationLink { StorageView(model: client) } label: { InsetRow("Storage", systemImage: "internaldrive") }
                .accessibilityIdentifier("machine.storage")
            NavigationLink { HostDiagnosticsView(model: client) } label: { InsetRow("Diagnostics", systemImage: "stethoscope") }
                .accessibilityIdentifier("machine.diagnostics")
            ForEach(RemoteSettingsCategory.all + (client.transfers.linked ? [.fleet] : [])) { category in
                NavigationLink { RemoteSettingsView(model: client, category: category) } label: {
                    InsetRow(category.title, systemImage: category.symbol)
                }
                .accessibilityIdentifier("machine.settings.\(category.title)")
            }
        } header: { InsetHeader("On this machine") }
        .insetRowBackground()
    }

    private func problemText(_ message: String, tone: Color) -> some View {
        Text(message).aceFont(AceDesign.TextRole.rowTitle)
            .foregroundStyle(tone).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("machine.problem")
    }
    @ViewBuilder private var providers: some View {
        Section {
            providerRows
        } header: { InsetHeader("Coding tools") }
        .insetRowBackground()
    }
    @ViewBuilder private var providerRows: some View {
        Group {
            if let info = client?.providers {
                ForEach(info.providers) { provider in ProviderRow(provider: provider) }
                if !info.absent.isEmpty {
                    Text("Not installed: \(info.absent.joined(separator: ", "))")
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                if let problem = info.problem {
                    Text(problem).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            } else if client?.connection == "ready" {
                HStack(spacing: AceDesign.Space.related) { WorkingMark(label: "Checking"); Text("Checking…") }
                    .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
            } else {
                Text("Shown once this phone reaches the computer.")
                    .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
            }
        }
    }
}
