import GameController
import SwiftUI

/// The Account root uses the same navigation stack as Profile, Archive and Settings.
struct AccountSheet: View {
    let inbox: MachineInbox
    let machines: MachinesModel?
    let machineFilter: String
    let showThreads: (String) -> Void
    let measure: (AccountSheetMeasurement) -> Void

    @State private var hasKeyboard = GCKeyboard.coalesced != nil
    @Environment(\.scenePhase) private var scenePhase
    @Environment(AceAccountModel.self) private var model: AceAccountModel?
    @Environment(SpacesModel.self) private var spaces: SpacesModel?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let listed = listedMachines
        let showsConnection = !listed.isEmpty || canPair
        List {
            Section {
                profile
            }
            .insetRowBackground()
            if let spaces, spaces.signedIn {
                SpacesSection(spaces: spaces)
            } else {
                Section {
                    InsetRow(icon: .user, title: "Personal", subtitle: "Your own machines") {
                        AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                            .foregroundStyle(AceDesign.Ink.action)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isSelected)
                    .accessibilityIdentifier("account.space.personal")
                } header: {
                    InsetHeader("Spaces")
                }
                .insetRowBackground()
            }
            Section {
                GroupLink(.archive) { InsetRow("Archived threads", icon: .archive) }
                    .accessibilityIdentifier("account.menu.archived")
                if hasKeyboard || UIDevice.current.userInterfaceIdiom == .pad {
                    GroupLink(.keyboard) { InsetRow("Keyboard shortcuts", icon: .keyboard) }
                        .accessibilityIdentifier("account.menu.keyboard")
                }
                GroupLink(.settings) { InsetRow("Settings", icon: .gearSix) }
                    .accessibilityIdentifier("account.menu.settings")
            } footer: {
                if !showsConnection { versionFooter }
            }
            .insetRowBackground()
            AccountUpdatesSection(computerName: updateHost(listed).map { machines?.entry($0)?.displayName ?? inbox.name($0) },
                                  computer: updateHost(listed).flatMap { inbox.client($0)?.appUpdate },
                                  client: updateHost(listed).flatMap { inbox.client($0) })
            if showsConnection { connection(listed) }
        }
        .insetGroupedList()
        .environment(\.defaultMinListRowHeight, AceDesign.Size.tap)
        .onScrollGeometryChange(for: AccountSheetMeasurement.self) { geometry in
            AccountSheetMeasurement(
                content: ceil(geometry.contentSize.height + geometry.contentInsets.top),
                viewport: floor(geometry.containerSize.height - geometry.contentInsets.bottom)
            )
        } action: { _, size in
            measure(size)
        }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidConnect)) { _ in hasKeyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: .GCKeyboardDidDisconnect)) { _ in hasKeyboard = false }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { hasKeyboard = GCKeyboard.coalesced != nil }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var listedMachines: [String] {
        let live = inbox.sessions.map(\.hostId)
        let saved = machines?.machines.map(\.hostId) ?? []
        return live + saved.filter { !live.contains($0) && (inbox.inSpace?($0) ?? true) }
    }

    /// The computer the Updates section describes: the chosen, connected one.
    private func updateHost(_ listed: [String]) -> String? {
        let chosen = listed.contains(machineFilter) ? machineFilter
            : inbox.sessions.first { $0.client.canOperate }?.hostId ?? listed.first
        return chosen
    }

    private var canPair: Bool {
        machines?.loaded == true && machines?.machines.isEmpty == true && inbox.all.isEmpty
    }

    private func connection(_ listed: [String]) -> some View {
        let chosen = listed.contains(machineFilter) ? machineFilter
            : inbox.sessions.first { $0.client.canOperate }?.hostId ?? listed.first
        return Section {
            ForEach(listed, id: \.self) { host in
                machineRow(host, chosen: host == chosen)
                    .contextMenu {
                        if listed.count > 1, host != machineFilter {
                            Button("Show this computer’s threads") { showThreads(host) }
                                .accessibilityIdentifier("account.menu.machine.\(host).showThreads")
                        }
                    }
            }
            if canPair {
                GroupLink(.pair) { InsetRow("Pair a computer", icon: .qrCode) }
                    .accessibilityIdentifier("account.menu.pair")
            }
        } header: {
            InsetHeader("Connection")
        } footer: {
            versionFooter
        }
        .insetRowBackground()
    }

    private var versionFooter: some View {
        let app = DiagnosticsReport.App.current
        return InsetHeader("ace \(app.version) (\(app.build))")
            .accessibilityIdentifier("account.menu.version")
    }

    private func machineRow(_ host: String, chosen: Bool) -> some View {
        let entry = machines?.entry(host)
        let client = inbox.client(host)
        let name = entry?.displayName ?? inbox.name(host)
        let state = client?.connection
        let available = machines?.isOff(host) != true && machines?.unsupported.contains(host) != true
        let connected = available && state == "ready"
        let trying = available && ["starting", "connecting", "reconnecting"].contains(state ?? "")
        let status = connected ? "Connected" : (trying ? "Reconnecting" : "Offline")
        return GroupLink(.machine(host)) {
            InsetRow(icon: MachineFacts.icon(entry?.icon?.kind), title: name, subtitle: status) {
                HStack(spacing: AceDesign.Space.related) {
                    ConnectionDot(token: connected ? "done" : "neutral", trying: trying)
                    if chosen {
                        AceIcon(.check, size: AceDesign.Size.groupGlyph, relativeTo: .subheadline)
                            .foregroundStyle(AceDesign.Ink.action)
                            .accessibilityHidden(true)
                    }
                }
            }
        }
        .accessibilityLabel(Text("\(name), \(status.lowercased())"))
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier("account.menu.machine.\(host)")
    }

    private var profile: some View {
        let person = model?.account
        let name = person?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = person == nil ? "Sign in to ace" : (name.isEmpty ? "You" : name)
        let label = [title, person?.email, "Profile"].compactMap { $0 }.filter { !$0.isEmpty }
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
            : AnyLayout(HStackLayout(spacing: AceDesign.Space.row))

        return GroupLink(.account) {
            layout {
                AccountAvatar(name: name, picture: model?.picture, size: AceDesign.Size.accountPortrait)
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(title).font(.headline).foregroundStyle(AceDesign.Ink.primary)
                    if let email = person?.email, !email.isEmpty {
                        Text(email).font(.subheadline).foregroundStyle(AceDesign.Ink.muted)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                            .truncationMode(.middle)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, AceDesign.Space.related)
        }
        .accessibilityLabel(Text(label.joined(separator: ", ")))
        .accessibilityIdentifier("account.menu.profile")
    }
}

struct AccountSheetMeasurement: Equatable {
    let content: CGFloat
    let viewport: CGFloat
}
