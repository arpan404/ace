import SwiftUI

/// The Spade tab (docs/design/spade.md §2): the bots of a machine that shows Spade, Spade itself
/// first, then whoever needs the person, then working, failed, finished and the rest, each with
/// its face, its name and one line. A bot opens its conversation. With several machines showing
/// Spade, the title's menu picks whose bots these are. Every word is the bridge's.
struct SpadeTab<Bar: View>: View {
    let inbox: MachineInbox
    /// The tab is the one showing: its bots are read only then.
    let chosen: Bool
    /// The phone's tab bar (`HomeBar`), at the list's foot: it steps away with the list for a
    /// conversation, as Projects' does for a page.
    @ViewBuilder let bar: () -> Bar
    @State private var machine: String?
    @State private var path: [SpadeRoute] = []
    @State private var watch = SpadeWatch()
    @State private var making = false
    @State private var settings = false

    private var session: MachineSession? {
        let shown = inbox.spadeSessions
        return shown.first { $0.hostId == machine } ?? shown.first
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let session { SpadeList(client: session.client) } else { Color.clear }
            }
            .homeBar { bar() }
            .navigationTitle(HomeTabs.title(.spade))
            .toolbar {
                if inbox.spadeSessions.count > 1 { ToolbarItem(placement: .topBarLeading) { machineMenu } }
                if session?.client.spade.shown == true {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { settings = true } label: { AceIcon(.gear) }
                            .accessibilityLabel("Spade settings")
                            .accessibilityIdentifier("spade.openSettings")
                        Button { making = true } label: { AceIcon(.notePencil) }
                            .accessibilityLabel("New bot")
                            .accessibilityIdentifier("spade.newBot")
                            .disabled(session?.client.spade.line?.ready != true)
                    }
                }
            }
            .navigationDestination(for: SpadeRoute.self) { route in
                if let client = session?.client {
                    SpadeConversationView(client: client, conversation: route.conversation, group: route.group) {
                        path.append($0)
                    }
                }
            }
        }
        .task(id: watchKey) {
            // Only the machine on screen reads its bots, only while the tab shows, and none once
            // the tab goes: the task ends with the view, and its hold stops the machine it named.
            let hold = watch.hold(session?.client, on: chosen, among: inbox.sessions.map(\.client))
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
            watch.release(hold)
        }
        .sheet(isPresented: $making) {
            if let client = session?.client {
                SpadeNewBotSheet(client: client) { conversation in
                    path = [SpadeRoute(conversation: conversation, group: nil)]
                }
            }
        }
        .sheet(isPresented: $settings) {
            if let client = session?.client {
                NavigationStack {
                    SpadeSettingsView(client: client)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { settings = false }.accessibilityIdentifier("spade.settings.done")
                            }
                        }
                }
                .tint(AceDesign.Ink.action)
                .toggleStyle(.systemSwitch)
            }
        }
        .modifier(HomeTabBar(relayout: "spade \(path.count)"))
        .onChange(of: session?.hostId) { path = [] }
    }

    private var watchKey: String { "\(session?.hostId ?? "")|\(chosen)" }

    private var machineMenu: some View {
        Menu {
            Picker("Machine", selection: Binding(get: { session?.hostId }, set: { machine = $0 })) {
                ForEach(inbox.spadeSessions) { shown in Text(inbox.name(shown.hostId)).tag(Optional(shown.hostId)) }
            }
        } label: {
            Image(ace: .desktop)
        }
        .accessibilityLabel("Machine")
        .accessibilityIdentifier("spade.machine")
    }
}

/// Where the Spade tab's stack goes: a bot's conversation, or a group's (ADR 0132).
struct SpadeRoute: Hashable {
    let conversation: String
    let group: String?
}

/// One machine's bots, or what Spade says while it can't list them.
private struct SpadeList: View {
    let client: ClientModel
    @State private var turning = false
    @State private var problem: String?

    private var spade: SpadeModel { client.spade }

    var body: some View {
        List { rows }
            .listStyle(.plain)
            .scrollsToTop(on: .spade, first: spade.bots?.first.map { AnyHashable($0.id) })
            .refreshable { client.spadeRefresh() }
            .accessibilityIdentifier("spade.list")
    }

    /// Why Spade isn't running, then its bots, the failure or skeleton rows while they load.
    @ViewBuilder private var rows: some View {
        if let line = spade.line, !line.ready {
            Section { placeLine(line) }
        }
        if let bots = spade.bots {
            // The groups read but the bots didn't: the groups show, and the bots can be read again.
            if spade.listFailed {
                ProblemRow("Couldn't read Spade's bots", id: "spade.listProblem") { client.spadeRefresh() }
            }
            ForEach(bots) { bot in
                NavigationLink(value: SpadeRoute(conversation: bot.conversation, group: bot.group)) { SpadeBotRow(bot: bot) }
                    .accessibilityIdentifier(bot.group.map { "spade.group.\($0)" } ?? "spade.bot.\(bot.id)")
            }
        } else if spade.listFailed {
            EmptyState(icon: nil, title: "Couldn't read Spade's bots", failed: true) {
                Button("Try again") { client.spadeRefresh() }
            }
            .listRowSeparator(.hidden)
        } else if spade.line?.ready == true {
            SkeletonRows(count: 4, retry: { client.spadeRefresh() })
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        }
    }

    /// Spade isn't running here: why, in its words, and Turn on where the setting is off.
    private func placeLine(_ line: SpadeModel.Line) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(line.sentence)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("spade.line")
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
            }
            if line.canTurnOn {
                Button("Turn on") {
                    turning = true
                    Task {
                        problem = await client.spadeTurnOn().problem
                        turning = false
                    }
                }
                .buttonStyle(.primaryAction)
                .disabled(turning)
                .accessibilityIdentifier("spade.turnOn")
            }
        }
        .padding(.vertical, AceDesign.Space.tight)
    }
}

/// A bot's row: its face with its state's dot, its name, and one line in its state's ink.
struct SpadeBotRow: View {
    let bot: SpadeModel.Bot
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            SpadeBotFace(bot: bot)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(bot.name)
                    .aceFont(AceDesign.TextRole.rowTitle)
                    .fontWeight(bot.state == "unseen" ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .lineLimit(1)
                Text(bot.line)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(lineInk)
                    .lineLimit(1)
            }
        }
        .frame(minHeight: AceDesign.Size.rowThread)
        .accessibilityElement(children: .combine)
    }

    private var lineInk: Color {
        switch bot.state {
        case "needs-you": AceTheme.StatusText.needsYou
        case "failed": AceTheme.StatusText.failed
        case "unseen": AceDesign.Ink.primary
        default: AceDesign.Ink.muted
        }
    }
}
