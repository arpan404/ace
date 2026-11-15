import SwiftUI

/// One paired computer: connection, access and address, the coding-agent CLIs it reports with
/// their sign-in and usage, its ace version and update, its own settings, then rename and remove. Words arrive from
/// `@ace/ui-core/mobile`.
struct MachineDetailView: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let hostId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var enteringCode = false
    @State private var code = ""

    private var client: ClientModel? { inbox.client(hostId) }

    var body: some View {
        let facts = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        List {
            if let machines, !facts.needsPairing {
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
                if let client, let ask = client.machineCodeAsk {
                    HStack {
                        problemText(ask.message(lockedUntil: client.machineCodeLockedUntil))
                        Spacer(minLength: AceTheme.Spacing.sm)
                        if ask.canEnter {
                            Button("Enter code") { enteringCode = true }
                                .buttonStyle(.borderless).accessibilityIdentifier("machine.code.enter")
                        }
                    }
                } else if let problem = facts.needsPairing ? nil : client?.problem {
                    // At accessibility sizes Retry goes under the message instead of squeezing it.
                    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.tight)) : AnyLayout(HStackLayout())
                    layout {
                        problemText(problem.message)
                        if !typeSize.isAccessibilitySize { Spacer(minLength: AceDesign.Space.related) }
                        retry(problem.code)
                    }
                }
            }
            .insetRowBackground()
            if let client, client.admission?.known == true {
                Section { MachineAdmissionRow(model: client) }.insetRowBackground()
            }
            providers
            if let client {
                MachineSoftwareSection(model: client, name: facts.name)
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

    private func problemText(_ message: String) -> some View {
        Text(message).font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.muted).accessibilityIdentifier("machine.problem")
    }
    @ViewBuilder private func retry(_ code: String) -> some View {
        if code == "unreachable" || code == "offline" {
            Button("Retry") { client?.retry() }.buttonStyle(.borderless).frame(minHeight: AceDesign.Size.tap)
        }
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

/// "Codex · Signed in as … ─ Ready", then what is left of each usage window.
struct ProviderRow: View {
    let provider: MachineProvidersInfo.Provider
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // At accessibility sizes the status and each usage value sit under their label.
        let stacked = typeSize.isAccessibilitySize
        let line = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                           : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AceDesign.Space.related))
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            line {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Label { Text(provider.name) } icon: { ProviderMark(provider: provider.provider, size: AceDesign.Size.icon) }.font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                    // The status word beside it already says "Sign in needed"; the line adds only what's new.
                    let summary = provider.summary.caseInsensitiveCompare(provider.status.label) == .orderedSame ? nil : provider.summary
                    Text([summary, provider.version].compactMap { $0 }.joined(separator: " · "))
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !stacked { Spacer(minLength: AceDesign.Space.related) }
                StateLabel(status: provider.status)
            }
            ForEach(provider.usage, id: \.self) { usage in
                line {
                    Text(usage.label)
                    if !stacked { Spacer(minLength: AceDesign.Space.related) }
                    Text([usage.left, usage.resets].compactMap { $0 }.joined(separator: " · ")).monospacedDigit()
                }
                .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("provider.\(provider.provider)")
    }
}
