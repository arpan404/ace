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
    @State private var path: [String] = []
    @State private var watch = SpadeWatch()

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
            .toolbar { if inbox.spadeSessions.count > 1 { ToolbarItem(placement: .topBarTrailing) { machineMenu } } }
            .navigationDestination(for: String.self) { conversation in
                if let client = session?.client {
                    SpadeConversationView(client: client, conversation: conversation)
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
            Image(systemName: "desktopcomputer")
        }
        .accessibilityLabel("Machine")
        .accessibilityIdentifier("spade.machine")
    }
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
            ForEach(bots) { bot in
                NavigationLink(value: bot.conversation) { SpadeBotRow(bot: bot) }
                    .accessibilityIdentifier("spade.bot.\(bot.id)")
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

/// A bot's face: Spade's own mark for Spade, else its initial on a quiet disc, with an amber dot
/// while it needs the person, red when it failed, grey while it is off.
struct SpadeBotFace: View {
    let bot: SpadeModel.Bot
    private static let size = AceDesign.Size.tap - AceDesign.Space.tight
    var body: some View {
        Group {
            if bot.main {
                SpadeMark(size: Self.size, moving: bot.state == "working").foregroundStyle(AceDesign.Ink.primary)
            } else {
                Text(bot.initial)
                    .aceFont(AceDesign.TextRole.header)
                    .foregroundStyle(AceDesign.Ink.primary)
                    .frame(width: Self.size, height: Self.size)
                    .background(AceDesign.Surface.fill, in: Circle())
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let dot {
                Circle().fill(dot)
                    .frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
                    .overlay(Circle().stroke(AceDesign.Surface.background, lineWidth: AceTheme.Dimensions.border * 2))
            }
        }
        .accessibilityHidden(true)
    }

    private var dot: Color? {
        switch bot.state {
        case "needs-you": AceDesign.Status.needsYou
        case "failed": AceDesign.Status.failed
        case "off": AceDesign.Ink.faint
        default: nil
        }
    }
}
