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
            if !inbox.sessions.isEmpty {
                Section {
                    NavigationLink { FleetRulesView(inbox: inbox) } label: {
                        InsetRow("Fleet rules", systemImage: "point.3.connected.trianglepath.dotted", subtitle: "Remote access and agents, on every machine")
                    }
                    .accessibilityIdentifier("machines.fleetRules")
                    .insetRowBackground()
                }
            }
            if machines != nil {
                Section {
                    ZStack {
                        // The card is the link; the system chevron would sit oddly beside a centred card.
                        NavigationLink(value: SettingsRoute.pair) { EmptyView() }.opacity(0)
                        VStack(spacing: AceDesign.Space.row) {
                            Image(systemName: "qrcode.viewfinder").font(AceDesign.Typeface.largeTitle)
                                .foregroundStyle(AceDesign.Ink.muted)
                            Text("Scan the code from ace on your computer")
                                .font(AceDesign.Typeface.title)
                                .foregroundStyle(AceDesign.Ink.muted)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, AceDesign.Space.group)
                    }
                    .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("machines.pair")
                    .insetRowBackground()
                } header: { InsetHeader("Pair a machine") }
            }
        }
        .insetGroupedList()
        .nativeTitle("Machines")
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
        HStack(spacing: AceDesign.Space.row) {
            ConnectionDot(token: facts.connection.token, trying: facts.trying)
            Image(systemName: facts.symbol).font(AceDesign.Typeface.title).foregroundStyle(AceDesign.Ink.primary)
                .frame(width: AceDesign.Size.icon + AceDesign.Space.related).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(facts.name).font(AceDesign.Typeface.body).fontWeight(.semibold)
                    .foregroundStyle(AceDesign.Ink.primary)
                Text(facts.subtitle).font(AceDesign.Typeface.code)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A connection dot: green when connected, faint while away, a dimmed amber while this phone is
/// still trying to reach it.
struct ConnectionDot: View {
    let token: String
    let trying: Bool
    var body: some View {
        Circle().fill(colour).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            // Still while it tries: the row's words say it is reconnecting.
            .opacity(trying ? AceDesign.Ink.recede : 1)
            .accessibilityHidden(true)
    }
    private var colour: Color {
        if token == "done" { return AceTheme.Status.done }
        if token == "failed" { return AceTheme.Status.failed }
        return trying ? AceTheme.Status.needsYou : AceDesign.Ink.faint
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
        address = entry?.isAccountMachine == true ? "Through your ace account"
            : entry.flatMap { URL(string: $0.target.url) }.map { url in [url.host, url.port.map(String.init)].compactMap { $0 }.joined(separator: ":") }
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
