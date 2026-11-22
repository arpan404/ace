import SwiftUI

/// The Marketplace place (spec items 1 to 4, 24): the market of the machine in view, browsed and
/// installed onto through that machine's daemon. With more than one machine paired the title is
/// a menu naming the machine, and switching it shows that machine's market. While the machine
/// can't be reached the connection banner shows over what this phone last kept.
struct MarketplaceView: View {
    let inbox: MachineInbox
    @State private var machine: String

    init(inbox: MachineInbox, machine: String) {
        self.inbox = inbox
        _machine = State(initialValue: machine)
    }

    private var hostId: String {
        inbox.sessions.contains { $0.hostId == machine } ? machine : inbox.sessions.first?.hostId ?? machine
    }

    var body: some View {
        Group {
            if let client = inbox.client(hostId) {
                MarketHomeView(model: client, machineName: inbox.name(hostId))
                    .id(hostId)
                    .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                        if client.connection != "ready" {
                            InboxConnectionBanner(connection: client.connection, retry: client.retry)
                                .padding(.horizontal, AceDesign.Space.margin)
                                .padding(.vertical, AceDesign.Space.tight)
                        }
                    }
            } else {
                EmptyState(icon: .store, title: "No machine", line: "Pair a machine to browse its Store.")
                    .frame(maxHeight: .infinity)
            }
        }
        .navigationTitle("Store")
        // A large title, as the store pages are; with a machine menu in the title it stays inline.
        .navigationBarTitleDisplayMode(inbox.sessions.count > 1 ? .inline : .large)
        .toolbar {
            if inbox.sessions.count > 1 {
                ToolbarItem(placement: .principal) { machineMenu }
            }
        }
    }

    /// The title, naming the machine whose market shows, as a menu of every paired machine.
    private var machineMenu: some View {
        Menu {
            Picker("Machine", selection: Binding(get: { hostId }, set: { machine = $0 })) {
                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
            }
        } label: {
            VStack(spacing: AceTheme.Spacing.none) {
                Text("Store").aceFont(AceTheme.Typography.body, relativeTo: .headline).fontWeight(AceDesign.Typeface.strong)
                HStack(spacing: AceDesign.Space.tight) {
                    Text(inbox.name(hostId)).aceFont(AceDesign.TextRole.meta)
                    AceIcon(.caretDown, size: AceDesign.Size.glyphMeta, relativeTo: .caption)
                }
                .foregroundStyle(AceDesign.Ink.muted)
            }
            .foregroundStyle(AceDesign.Ink.primary)
        }
        .accessibilityLabel("Store on \(inbox.name(hostId))")
        .accessibilityHint("Choose the machine")
        .accessibilityIdentifier("market.machine")
    }
}
