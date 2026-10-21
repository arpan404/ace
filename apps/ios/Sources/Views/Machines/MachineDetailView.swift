import SwiftUI

/// One paired computer: connection, access and address, the coding-agent CLIs it reports with
/// their sign-in and usage, its own settings, then rename and remove. Words arrive from
/// `@ace/ui-core/mobile`.
struct MachineDetailView: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let hostId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var renaming = false
    @State private var newName = ""
    @State private var removing = false
    @State private var notice: ProblemNotice?

    private var client: ClientModel? { inbox.client(hostId) }

    var body: some View {
        let facts = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        List {
            Section {
                LabeledContent("Connection") { StateLabel(status: facts.connection) }
                    .accessibilityIdentifier("machine.connection")
                if !facts.connected {
                    LabeledContent("Last seen", value: facts.lastSeen.map { $0.formatted(.relative(presentation: .named)) } ?? "Not yet")
                }
                if let readOnly = facts.readOnly {
                    LabeledContent("Access", value: readOnly ? "View only" : "Full access").accessibilityIdentifier("machine.access")
                }
                if let address = facts.address {
                    LabeledContent("Address") { Text(address).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote) }
                }
                if let version = client?.providers?.version { LabeledContent("ace", value: version) }
                if let problem = facts.needsPairing ? nil : client?.problem {
                    // At accessibility sizes Retry goes under the message instead of squeezing it.
                    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xs)) : AnyLayout(HStackLayout())
                    layout {
                        problemText(problem.message)
                        if !typeSize.isAccessibilitySize { Spacer(minLength: AceTheme.Spacing.sm) }
                        retry(problem.code)
                    }
                }
            }
            .insetRowBackground()
            providers
            if let client {
                Section {
                    ForEach(RemoteSettingsCategory.all) { category in
                        NavigationLink { RemoteSettingsView(model: client, category: category) } label: {
                            InsetRow(category.title, systemImage: category.symbol)
                        }
                    }
                } header: { InsetHeader("On this machine") }
                .insetRowBackground()
            }
            if let machines {
                Section {
                    Button("Rename") { newName = facts.name; renaming = true }.accessibilityIdentifier("machine.rename")
                        .foregroundStyle(AceTheme.Colours.foreground)
                    Button("Remove from this phone", role: .destructive) { removing = true }.accessibilityIdentifier("machine.remove")
                } footer: {
                    Text("Removing forgets this phone's access and unsent work for \(facts.name). Revoke the device on the computer too.")
                }
                .alert("Rename machine", isPresented: $renaming) {
                    TextField("Name", text: $newName).accessibilityIdentifier("machine.rename.field")
                    Button("Cancel", role: .cancel) {}
                    Button("Save") { Task { notice = await machines.rename(hostId, to: newName) } }
                } message: { Text("The name is for this phone; the computer keeps its own.") }
                .confirmationDialog("Remove \(facts.name)?", isPresented: $removing, titleVisibility: .visible) {
                    Button("Remove \(facts.name)", role: .destructive) {
                        Task { await machines.remove(hostId); dismiss() }
                    }.accessibilityIdentifier("machine.remove.confirm")
                } message: { Text("This phone forgets its access and unsent work for that computer.") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .navigationTitle(facts.name).navigationBarTitleDisplayMode(.inline)
        .task(id: hostId) { client?.refreshMachine() }
        .refreshable { client?.refreshMachine() }
        .alert("Couldn't rename", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button("OK") { notice = nil }
        } message: { Text(notice?.message ?? "") }
    }

    private func problemText(_ message: String) -> some View {
        Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("machine.problem")
    }
    @ViewBuilder private func retry(_ code: String) -> some View {
        if code == "unreachable" || code == "offline" {
            Button("Retry") { client?.retry() }.buttonStyle(.borderless).frame(minHeight: AceTheme.Dimensions.touchTarget)
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
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                if let problem = info.problem {
                    Text(problem).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            } else if client?.connection == "ready" {
                HStack(spacing: AceTheme.Spacing.sm) { ProgressView().controlSize(.mini); Text("Checking…") }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            } else {
                Text("Shown once this phone reaches the computer.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
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
                           : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            line {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(provider.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                    Text([provider.summary, provider.version].compactMap { $0 }.joined(separator: " · "))
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                StateLabel(status: provider.status)
            }
            ForEach(provider.usage, id: \.self) { usage in
                line {
                    Text(usage.label)
                    if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                    Text([usage.left, usage.resets].compactMap { $0 }.joined(separator: " · ")).monospacedDigit()
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("provider.\(provider.provider)")
    }
}
