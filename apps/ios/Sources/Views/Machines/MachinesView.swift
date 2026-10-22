import SwiftUI

/// Settings › Machines: every paired computer with its connection, one tap from its detail, and
/// a row to pair another. Pushed inside Settings' own stack.
struct MachinesView: View {
    let inbox: MachineInbox
    /// Directory operations; nil for the debug fixture, which only shows connections.
    var machines: MachinesModel?

    var body: some View {
        List {
            Section {
                ForEach(inbox.sessions) { session in
                    NavigationLink(value: SettingsRoute.machine(session.hostId)) { MachineRow(inbox: inbox, machines: machines, hostId: session.hostId) }
                        .accessibilityIdentifier("machines.row.\(session.hostId)")
                }
                ForEach(unsupported) { entry in
                    NavigationLink(value: SettingsRoute.machine(entry.hostId)) { MachineRow(inbox: inbox, machines: machines, hostId: entry.hostId) }
                }
                if machines != nil {
                    NavigationLink(value: SettingsRoute.pair) {
                        SettingsRow(title: "Pair a machine", description: "Scan the code from ace on your computer.") { EmptyView() }
                    }
                    .accessibilityIdentifier("machines.pair")
                }
            } header: { SettingsHeader("Paired") }
            .settingsRow()
        }
        .settingsList()
        .navigationTitle("Machines").navigationBarTitleDisplayMode(.inline)
    }
    private var unsupported: [MachineEntry] {
        machines.map { model in model.machines.filter { model.unsupported.contains($0.hostId) } } ?? []
    }
}

/// "● 💻 studio / studio.tail0f.ts.net", or "Offline · 2 days ago" while it's away.
struct MachineRow: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let hostId: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let facts = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        HStack(spacing: AceTheme.Spacing.md) {
            AceIcon(facts.icon, size: 18).foregroundStyle(AceTheme.Colours.subtleForeground)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(facts.name).aceFont(SettingsStyle.label, relativeTo: .body).fontWeight(.medium)
                    .foregroundStyle(AceTheme.Colours.foreground)
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    ConnectionDot(token: facts.connection.token, trying: facts.trying)
                    Text(facts.subtitle).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A 7pt connection dot: green when connected, faint while away, a pulsing amber while this
/// phone is still trying to reach it.
struct ConnectionDot: View {
    let token: String
    let trying: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false
    var body: some View {
        Circle().fill(colour).frame(width: 7, height: 7)
            .opacity(trying && dim ? 0.35 : 1)
            .animation(trying && !reduceMotion ? .easeInOut(duration: AceTheme.Motion.statusPulse / 2).repeatForever(autoreverses: true) : nil, value: dim)
            .onAppear { dim = trying && !reduceMotion }
            .onChange(of: trying) { _, now in dim = now && !reduceMotion }
            .accessibilityHidden(true)
    }
    private var colour: Color {
        if token == "done" { return AceTheme.Status.done }
        if token == "failed" { return AceTheme.Status.failed }
        return trying ? AceTheme.Status.needsYou : AceTheme.Colours.decoration
    }
}

/// What the machine screens say about one machine, read from its runtime and the directory.
@MainActor struct MachineFacts {
    let name: String
    let connection: StatusDisplay
    let lastSeen: Date?
    let readOnly: Bool?
    let address: String?
    let needsPairing: Bool
    /// The SDK is connecting or reconnecting to it right now.
    let trying: Bool
    let icon: AceIcon.Name

    init(inbox: MachineInbox, machines: MachinesModel?, hostId: String) {
        let entry = machines?.entry(hostId)
        let client = inbox.client(hostId)
        name = entry?.displayName ?? inbox.name(hostId)
        needsPairing = machines?.unsupported.contains(hostId) ?? false
        connection = needsPairing ? StatusDisplay(label: "Pair again", token: "failed")
            : client?.machineStatus?.status ?? StatusDisplay(label: "Connecting…", token: "neutral")
        trying = !needsPairing && ["connecting", "reconnecting"].contains(client?.connection ?? "")
        lastSeen = inbox.lastSeen(hostId).map { Date(timeIntervalSince1970: $0 / 1000) }
        readOnly = machines.map { $0.isReadOnly(hostId) }
        address = entry.flatMap { URL(string: $0.target.url) }.map { url in [url.host, url.port.map(String.init)].compactMap { $0 }.joined(separator: ":") }
        icon = Self.icon(entry?.icon?.kind)
    }
    var connected: Bool { connection.token == "done" }
    /// The address while connected; otherwise the connection word and when it was last seen.
    var subtitle: String {
        var parts: [String] = []
        if connected { parts.append(address ?? connection.label) }
        else {
            parts.append(connection.label)
            if let lastSeen, let age = ActivityTime.elapsed(since: lastSeen, now: Date()) { parts.append(age) }
        }
        if readOnly == true { parts.append("View only") }
        return parts.joined(separator: " · ")
    }
    /// The person's machine mark (`MachineIconKind`); a laptop when there is none.
    static func icon(_ kind: String?) -> AceIcon.Name {
        switch kind {
        case "desktop": .desktop
        case "monitor": .monitor
        case "server": .hardDrives
        case "cloud": .cloud
        case "cpu": .cpu
        case "terminal": .terminalWindow
        case "phone": .deviceMobile
        default: .laptop
        }
    }
}
