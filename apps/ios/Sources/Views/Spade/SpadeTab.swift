import SwiftUI

/// The Spade tab (docs/design/spade.md §2): one list of the bots on every machine of the space
/// shown that shows Spade (`MachineInbox.spadeRoster`), Spade itself once, from the machine the
/// fleet chose to host it, then whoever needs the person, then working, failed, finished and the
/// rest, each with its face, its name, one line and, with several machines, the machine it runs
/// on. A bot opens its conversation on its own machine. New makes a bot or a group (ADR 0132).
/// Every word about a bot is its bridge's.
struct SpadeTab: View {
    let inbox: MachineInbox
    /// The tab is the one showing: its bots are read only then.
    let chosen: Bool
    /// Bumped by `ace://spade/talk`: the main Spade opens with its recorder recording.
    var talks = 0
    @State private var talkWaiting = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var path: [SpadeRoute] = []
    @State private var watch = SpadeWatch()
    /// The machine New bot makes its bot on, once chosen; asking shows the choice first.
    @State private var making: SpadeMachineChoice?
    @State private var asking = false
    /// A Settings page asked for from New bot's sheet (Pair again names the sheet's own
    /// machine), opened once that sheet has closed.
    @State private var settingsAfterMaking: SettingsRoute?
    @Environment(\.openSettingsPage) private var openSettingsPage
    @State private var settings: SpadeMachineChoice?
    /// New group's sheet shows.
    @State private var grouping = false

    private var machines: [MachineSession] { inbox.spadeSessions }
    private var hosts: [MachineSession] { inbox.spadeHosts }
    /// Every machine that shows Spade, for a profile's Move to….
    private var moveTargets: [SpadeMoveTarget] {
        machines.map { session in
            SpadeMoveTarget(host: session.client.spade.host ?? session.hostId, name: inbox.name(session.hostId),
                            ready: inbox.spadeHosts.contains { $0.hostId == session.hostId }, client: session.client)
        }
    }
    /// Where Settings opens: the machine Spade shows from, else the first that answers.
    private var settingsMachine: String? {
        inbox.spadeRoster.first { $0.bot.main }?.machine ?? hosts.first?.hostId ?? machines.first?.hostId
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if machines.isEmpty { Color.clear } else { SpadeList(inbox: inbox) }
            }
            .navigationTitle(HomeTabs.title(.spade))
            .toolbar {
                if !machines.isEmpty {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { settings = settingsMachine.map(SpadeMachineChoice.init) } label: { AceIcon(.gear) }
                            .accessibilityLabel("Spade settings")
                            .accessibilityIdentifier("spade.openSettings")
                        Menu {
                            Button(action: newBot) { Label("New bot", ace: .robot) }
                                .accessibilityIdentifier("spade.newBot")
                            Button { grouping = true } label: { Label("New club", ace: .users) }
                                .accessibilityIdentifier("spade.newGroup")
                        } label: { AceIcon(.notePencil) }
                            .accessibilityLabel("New")
                            .accessibilityIdentifier("spade.new")
                            .disabled(hosts.isEmpty)
                    }
                }
            }
            .navigationDestination(for: SpadeRoute.self) { route in
                if let client = inbox.client(route.machine) {
                    SpadeConversationView(client: client, conversation: route.conversation, group: route.group, talk: route.talk, open: {
                        // A worker's chat opened from this one is on the same machine.
                        path.append(SpadeRoute(conversation: $0.conversation, group: $0.group, machine: route.machine))
                    }, groupChoices: route.group == nil ? [] : SpadeGroupDraft.choices(inbox.spadeMachines))
                    // A conversation has no tab bar, as Projects' pages: its composer takes the foot.
                    .toolbarVisibility(.hidden, for: .tabBar)
                    .environment(\.spadeMoveTargets, moveTargets)
                }
            }
        }
        .task(id: watchKey) {
            // Every machine in the list reads its bots, only while the tab shows, and none once
            // the tab goes: the task ends with the view, and its hold stops the machines it named.
            let hold = watch.hold(machines.map(\.client), on: chosen, among: inbox.sessions.map(\.client))
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
            watch.release(hold)
        }
        .confirmationDialog("New bot on", isPresented: $asking, titleVisibility: .visible) {
            ForEach(hosts) { host in
                Button(inbox.name(host.hostId)) { making = SpadeMachineChoice(id: host.hostId) }
                    .accessibilityIdentifier("spade.newBot.machine.\(host.hostId)")
            }
        }
        .sheet(item: $making, onDismiss: {
            guard let route = settingsAfterMaking else { return }
            settingsAfterMaking = nil
            openSettingsPage(route)
        }) { choice in
            // The chosen machine's client: its refusals, and Pair again, are that machine's.
            if let client = inbox.client(choice.id) {
                SpadeNewBotSheet(client: client, machineName: inbox.name(choice.id)) { conversation in
                    path = [SpadeRoute(conversation: conversation, group: nil, machine: choice.id)]
                }
                // Settings can't show over this sheet: it closes, then the page opens.
                .environment(\.openSettingsPage) { route in settingsAfterMaking = route; making = nil }
            }
        }
        .sheet(isPresented: $grouping) {
            SpadeGroupNewSheet(choices: SpadeGroupDraft.choices(inbox.spadeMachines),
                               spadeOn: inbox.spadeRoster.first { $0.bot.main }?.machine,
                               client: { inbox.client($0) }) { path = [$0] }
        }
        .sheet(item: $settings) { choice in
            if let client = inbox.client(choice.id) {
                NavigationStack {
                    SpadeSettingsView(client: client)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { settings = nil }.accessibilityIdentifier("spade.settings.done")
                            }
                        }
                }
                .tint(AceDesign.Ink.action)
                .toggleStyle(.systemSwitch)
            }
        }
        // A phone's tab bar shows over the bots and steps away for a conversation.
        .modifier(HomeTabBar(hidden: sizeClass == .regular || !path.isEmpty, animated: sizeClass != .regular,
                             relayout: "spade \(path.count)"))
        // Another space, or a machine that stops showing Spade: its conversations close.
        .onChange(of: machineKeys) { _, keys in path.removeAll { !keys.contains($0.machine) } }
        // Talk to Spade: the main Spade once the list has it, which after a cold launch is a moment.
        .onChange(of: talks) { talkWaiting = true; talk() }
        .onChange(of: mainEntry?.id) { talk() }
    }

    private var mainEntry: SpadeRoster.Entry? { inbox.spadeRoster.first { $0.bot.main } }

    private func talk() {
        guard talkWaiting, let main = mainEntry else { return }
        talkWaiting = false
        path = [SpadeRoute(conversation: main.bot.conversation, group: nil, machine: main.machine, talk: true)]
    }

    private var machineKeys: [String] { machines.map(\.hostId) }
    private var watchKey: String { "\(machineKeys.joined(separator: ","))|\(chosen)" }

    /// New bot runs where Spade answers: on the only such machine, else on the one the person picks.
    private func newBot() {
        if hosts.count > 1 { asking = true } else { making = hosts.first.map { SpadeMachineChoice(id: $0.hostId) } }
    }
}

/// A machine a sheet opens for, by its inbox host id.
private struct SpadeMachineChoice: Identifiable {
    let id: String
}

/// Where the Spade tab's stack goes: a bot's conversation, or a group's (ADR 0132), on the
/// machine it runs on (its inbox host id). A route made inside a conversation names no machine;
/// the tab gives it the conversation's own.
struct SpadeRoute: Hashable {
    let conversation: String
    let group: String?
    var machine = ""
    /// Opened by Talk to Spade: the recorder starts at once.
    var talk = false
}

/// The bots of every machine that shows Spade, or what each Spade says while it can't list them;
/// the pinned ones in the strip above the rest, and Pin or Unpin on a row's long press and swipe.
private struct SpadeList: View {
    let inbox: MachineInbox

    /// Why the last Pin or Unpin was refused, until the person closes it.
    @State private var pinProblem: String?

    private var entries: [SpadeRoster.Entry] { inbox.spadeRoster }
    private var machines: [MachineSession] { inbox.spadeSessions }

    var body: some View {
        List { rows }
            .alert(pinProblem ?? "", isPresented: Binding(get: { pinProblem != nil }, set: { if !$0 { pinProblem = nil } })) {
                Button("Close", role: .cancel) { pinProblem = nil }
            }
            .listStyle(.plain)
            .scrollsToTop(on: .spade, first: SpadeRoster.listRows(SpadePins.split(entries).rows).first.map { AnyHashable($0.id) })
            .refreshable { for machine in machines { machine.client.spadeRefresh() } }
            .accessibilityIdentifier("spade.list")
    }

    /// Why a Spade isn't running, then the bots, a failure or skeleton rows while they load.
    @ViewBuilder private var rows: some View {
        ForEach(machines) { machine in
            if let line = machine.client.spade.line, !line.ready {
                Section { SpadePlaceLine(client: machine.client, line: line, machine: machineName(machine.hostId)) }
            }
        }
        ForEach(machines.filter { $0.client.spade.listFailed && $0.client.spade.bots != nil }) { machine in
            // The groups read but the bots didn't: the groups show, and the bots can be read again.
            ProblemRow(problem(machine.hostId), id: "spade.listProblem") { machine.client.spadeRefresh() }
        }
        if !entries.isEmpty {
            let pins = SpadePins.split(entries)
            if !pins.strip.isEmpty {
                SpadePinStrip(entries: pins.strip, route: route) { pin($0, false) }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
            ForEach(SpadeRoster.listRows(pins.rows)) { row in
                let entry = row.entry
                NavigationLink(value: route(entry)) {
                    SpadeBotRow(bot: entry.bot, machine: machineName(entry.machine))
                        .padding(.leading, row.indented ? SpadeBotFace.size + AceDesign.Space.row : 0)
                }
                .listRowSeparator(row.indented ? .hidden : .automatic, edges: .top)
                .listRowSeparator(row.joinsNext ? .hidden : .automatic, edges: .bottom)
                .contextMenu { pinButton(entry) }
                .swipeActions(edge: .leading) { pinButton(entry).tint(AceDesign.Ink.action) }
                .accessibilityIdentifier(entry.bot.group.map { "spade.group.\($0)" } ?? "spade.bot.\(entry.bot.id)")
            }
        } else if let failed = machines.first(where: { $0.client.spade.listFailed && $0.client.spade.bots == nil }),
                  !machines.contains(where: { $0.client.spade.bots == nil && !$0.client.spade.listFailed && $0.client.spade.line?.ready == true }) {
            EmptyState(icon: nil, title: problem(failed.hostId), failed: true) {
                Button("Try again") { for machine in machines { machine.client.spadeRefresh() } }
            }
            .listRowSeparator(.hidden)
        } else if machines.contains(where: { $0.client.spade.bots == nil && $0.client.spade.line?.ready == true }) {
            SkeletonRows(count: 4, retry: { for machine in machines { machine.client.spadeRefresh() } })
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)
        }
    }

    private func route(_ entry: SpadeRoster.Entry) -> SpadeRoute {
        SpadeRoute(conversation: entry.bot.conversation, group: entry.bot.group, machine: entry.machine)
    }

    /// Pin or Unpin, on every row but Spade's own.
    @ViewBuilder private func pinButton(_ entry: SpadeRoster.Entry) -> some View {
        if SpadePins.pinnable(entry.bot) {
            let on = !entry.bot.pinned
            Button { pin(entry, on) } label: { Label(on ? "Pin" : "Unpin", ace: on ? .pushPin : .pushPinSlash) }
                .accessibilityIdentifier(on ? "spade.pin" : "spade.unpin")
        }
    }

    /// Pins or unpins on the machine the bot or group lives on; a refusal says why.
    private func pin(_ entry: SpadeRoster.Entry, _ on: Bool) {
        guard let client = inbox.client(entry.machine) else { return }
        Task {
            let outcome: SpadeOutcome
            if let group = entry.bot.group { outcome = await client.spadeGroupPin(group, pinned: on) }
            else { outcome = await client.spadePin(entry.bot.id, pinned: on) }
            pinProblem = outcome.problem
        }
    }

    /// A machine's name, only while there is more than one to tell apart.
    private func machineName(_ hostId: String) -> String? { machines.count > 1 ? inbox.name(hostId) : nil }

    private func problem(_ hostId: String) -> String {
        machineName(hostId).map { "Couldn't read Spade's bots on \($0)" } ?? "Couldn't read Spade's bots"
    }
}

/// A machine's Spade isn't running: why, in its words, the machine with several, and Turn on
/// where the setting is off.
private struct SpadePlaceLine: View {
    let client: ClientModel
    let line: SpadeModel.Line
    let machine: String?
    @State private var turning = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(line.sentence)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("spade.line")
            if let machine {
                Text(machine).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
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
    /// The machine it runs on, while the list holds more than one.
    var machine: String? = nil
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            SpadeBotFace(bot: bot)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.tight) {
                    Text(bot.name)
                        .accessibilityLabel(bot.parent.map { "\(bot.name), worker of \($0.name)" } ?? bot.name)
                        .aceFont(AceDesign.TextRole.rowTitle)
                        .fontWeight(bot.state == "unseen" ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .lineLimit(1)
                    // A bot an organization shares (ADR 0206 §2.3): the quieter word after its name.
                    if let shared = bot.shared {
                        Text("Shared")
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceDesign.Ink.muted)
                            .layoutPriority(1)
                            .accessibilityLabel(shared)
                            .accessibilityIdentifier("spade.bot.shared")
                    }
                }
                Text(bot.line)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(lineInk)
                    .lineLimit(1)
                if let machine {
                    Text(machine)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .lineLimit(1)
                        .accessibilityIdentifier("spade.bot.machine")
                }
            }
        }
        .frame(minHeight: AceDesign.Size.tap)
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
