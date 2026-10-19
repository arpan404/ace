import SwiftUI

/// The Machines sheet (issue #560, mockup panel 6): every paired computer with its connection
/// and when this phone last saw it, one tap from its CLIs, rename and removal, plus pairing.
struct MachinesSheet: View {
    let inbox: MachineInbox
    /// Directory operations; nil for the debug fixture, which only shows connections.
    var machines: MachinesModel?
    var add: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(inbox.sessions) { session in
                        NavigationLink(value: session.hostId) { MachineRow(inbox: inbox, machines: machines, hostId: session.hostId) }
                            .accessibilityIdentifier("machines.row.\(session.hostId)")
                    }
                    ForEach(unsupported) { entry in
                        NavigationLink(value: entry.hostId) { MachineRow(inbox: inbox, machines: machines, hostId: entry.hostId) }
                    }
                }
                if machines != nil {
                    Section {
                        Button(action: add) { Label("Pair a machine", systemImage: "qrcode.viewfinder") }
                            .accessibilityIdentifier("machines.pair")
                    } footer: {
                        Text("Run ace pair on your computer and scan its code. ace never holds your provider logins.")
                    }
                }
            }
            .navigationTitle("Machines").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { hostId in MachineDetailView(inbox: inbox, machines: machines, hostId: hostId) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if machines != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: add) { Image(systemName: "plus") }.accessibilityLabel("Pair a machine")
                    }
                }
            }
        }
        .adaptiveSheetDetents().presentationDragIndicator(.visible)
    }
    private var unsupported: [MachineEntry] {
        machines.map { model in model.machines.filter { model.unsupported.contains($0.hostId) } } ?? []
    }
}

/// "● studio · Connected", "● build-box · Offline · last seen 2h ago".
struct MachineRow: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let hostId: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let status = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        HStack(spacing: AceTheme.Spacing.md) {
            Circle().fill(StateStyle.marker(status.connection.token))
                .frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(status.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                Text(status.subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// What the sheet says about one machine, read from its runtime and the directory.
@MainActor struct MachineFacts {
    let name: String
    let connection: StatusDisplay
    let lastSeen: Date?
    let readOnly: Bool?
    let address: String?
    let needsPairing: Bool

    init(inbox: MachineInbox, machines: MachinesModel?, hostId: String) {
        let entry = machines?.entry(hostId)
        let client = inbox.client(hostId)
        name = entry?.displayName ?? inbox.name(hostId)
        needsPairing = machines?.unsupported.contains(hostId) ?? false
        connection = needsPairing ? StatusDisplay(label: "Pair again", token: "failed")
            : client?.machineStatus?.status ?? StatusDisplay(label: "Connecting…", token: "neutral")
        lastSeen = inbox.lastSeen(hostId).map { Date(timeIntervalSince1970: $0 / 1000) }
        readOnly = machines.map { $0.isReadOnly(hostId) }
        address = entry.flatMap { URL(string: $0.target.url) }.map { url in [url.host, url.port.map(String.init)].compactMap { $0 }.joined(separator: ":") }
    }
    var connected: Bool { connection.token == "done" }
    /// The connection word, then when it was last seen unless it is connected now.
    var subtitle: String {
        var parts = [connection.label]
        if !connected { parts.append(lastSeen.map { "last seen \($0.formatted(.relative(presentation: .named)))" } ?? "not seen yet") }
        if readOnly == true { parts.append("View only") }
        return parts.joined(separator: " · ")
    }
}
