import SwiftUI

/// Settings › Machines: every paired computer with its connection, one tap from its detail, and
/// + to pair another. Pushed inside Settings' own stack.
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
                        .insetRowBackground()
                }
                ForEach(unsupported) { entry in
                    NavigationLink(value: SettingsRoute.machine(entry.hostId)) { MachineRow(inbox: inbox, machines: machines, hostId: entry.hostId) }
                        .insetRowBackground()
                }
            }
            if machines != nil {
                Section {
                    ZStack {
                        // The card is the link; the system chevron would sit oddly beside a centred card.
                        NavigationLink(value: SettingsRoute.pair) { EmptyView() }.opacity(0)
                        VStack(spacing: AceTheme.Spacing.md) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 34, weight: .regular))
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                            Text("Scan the code from ace on your computer")
                                .aceFont(AceTheme.Typography.body, relativeTo: .body)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, AceTheme.Spacing.xl)
                    }
                    .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("machines.pair")
                    .insetRowBackground()
                } header: { InsetHeader("Pair a machine") }
            }
        }
        .insetGroupedList()
        .navigationTitle("Machines").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if machines != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: SettingsRoute.pair) { Image(systemName: "plus") }
                        .accessibilityLabel("Pair a machine").accessibilityIdentifier("machines.add")
                }
            }
        }
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
            ConnectionDot(token: facts.connection.token, trying: facts.trying)
            Image(systemName: facts.symbol).font(.system(size: 19)).foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(facts.name).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).fontWeight(.semibold)
                    .foregroundStyle(AceTheme.Colours.foreground)
                Text(facts.subtitle).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// An 8pt connection dot: green when connected, faint while away, a pulsing amber while this
/// phone is still trying to reach it.
struct ConnectionDot: View {
    let token: String
    let trying: Bool
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var dim = false
    var body: some View {
        Circle().fill(colour).frame(width: 8, height: 8)
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
    let symbol: String
    /// New work is paused there ("Pause new work").
    let paused: Bool

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
        symbol = Self.symbol(entry?.icon?.kind)
        paused = client?.admission?.paused == true
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
        if paused { parts.append("New work paused") }
        if readOnly == true { parts.append("View only") }
        return parts.joined(separator: " · ")
    }
    /// The person's machine mark (`MachineIconKind`); a laptop when there is none.
    static func symbol(_ kind: String?) -> String {
        switch kind {
        case "desktop": "desktopcomputer"
        case "monitor": "display"
        case "server": "server.rack"
        case "cloud": "cloud"
        case "cpu": "cpu"
        case "terminal": "apple.terminal"
        case "phone": "iphone"
        default: "laptopcomputer"
        }
    }
}
