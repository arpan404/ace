import SwiftUI

/// The Spade tab, as the web's Spade place (ADR 0127): "Spade" and New bot, Spade's state in one
/// sentence while it isn't running (with Turn on while it is off), then a messenger's list:
/// Spade first, then each bot by latest activity, with its face, name, when it was last active
/// and what it does now, or its latest message. Spade runs on each machine; with several paired
/// the header's menu picks which machine's Spade and bots these are.
struct SpadeHome: View {
    let inbox: MachineInbox
    @AppStorage("ace.spade.machine") private var chosen = ""
    @State private var path: [SpadeModel.Opened] = []
    @State private var creating = false

    private var hostId: String {
        inbox.sessions.contains { $0.hostId == chosen } ? chosen : inbox.sessions.first?.hostId ?? ""
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model = inbox.client(hostId) {
                    SpadeRoster(model: model, open: { path.append($0) }, create: { creating = true })
                        .id(hostId)
                } else {
                    EmptyState(icon: .desktop, title: "No machine paired", line: "Pair a machine to talk to its Spade.")
                }
            }
            .navigationTitle("Spade")
            .toolbar {
                if inbox.sessions.count > 1 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Machine", selection: Binding(get: { hostId }, set: { chosen = $0; path = [] })) {
                                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                            }
                        } label: { AceIcon(.desktop, size: AceDesign.Size.barIcon) }
                        .accessibilityLabel("Machine")
                        .accessibilityValue(inbox.name(hostId))
                        .accessibilityIdentifier("spade.machine")
                    }
                }
                if let model = inbox.client(hostId), model.spade.line?.ready == true {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { creating = true } label: { AceIcon(.notePencil, size: AceDesign.Size.barIcon) }
                            .accessibilityLabel("New bot")
                            .accessibilityIdentifier("spade.new")
                    }
                }
            }
            .navigationDestination(for: SpadeModel.Opened.self) { bot in
                if let model = inbox.client(hostId) { SpadeConversationView(model: model, bot: bot) }
            }
            .sheet(isPresented: $creating) {
                if let model = inbox.client(hostId) {
                    SpadeNewBot(model: model) { made in
                        creating = false
                        path.append(made)
                    }
                }
            }
        }
        .background(AceTheme.Colours.background)
    }
}

/// One machine's Spade: its state line, then Spade and its bots.
private struct SpadeRoster: View {
    let model: ClientModel
    let open: (SpadeModel.Opened) -> Void
    let create: () -> Void
    @State private var turning: SpadeOutcome?
    @State private var saving = false

    private var spade: SpadeModel { model.spade }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if let line = spade.line, !line.ready { stateLine(line) }
                else if let setup = spade.setup { quiet(setup).padding(.horizontal, AceDesign.Space.margin) }
                if let failed = turning?.words {
                    Text(failed)
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.StatusText.failed)
                        .padding(.horizontal, AceDesign.Space.margin)
                }
                list
            }
            .padding(.vertical, AceDesign.Space.related)
        }
        .refreshable { model.spadeRefresh() }
        .onAppear { model.spadeWatch(true) }
        .onDisappear { model.spadeWatch(false) }
    }

    // The last roster stays while Spade restarts or a read fails; it reads again on its own.
    @ViewBuilder private var list: some View {
        if let bots = spade.bots {
            if bots.isEmpty {
                if spade.line?.ready == true {
                    EmptyState(icon: .chatTeardropText, title: "No bots yet") {
                        Button("New bot", action: create).buttonStyle(.textAction(.prominent))
                    }
                }
            } else {
                QuietSection {
                    ForEach(bots) { bot in
                        Button { open(SpadeModel.Opened(agentId: bot.id, conversationId: bot.conversation)) } label: {
                            SpadeBotRow(model: model, bot: bot)
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityIdentifier("spade.bot.\(bot.id)")
                    }
                }
            }
        } else if spade.rosterFailed {
            EmptyState(icon: .warningCircle, title: "Couldn't read Spade's bots", failed: true) {
                Button("Try again") { model.spadeRefresh() }.buttonStyle(.textAction(.prominent))
            }
        } else if spade.line?.ready == true {
            SkeletonRows(count: 4, label: "Loading bots")
        }
    }

    /// Spade's state in one sentence, with Turn on while the setting is off.
    private func stateLine(_ line: SpadeModel.Line) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            quiet(line.sentence).frame(maxWidth: .infinity, alignment: .leading)
            if line.canTurnOn {
                Button(saving ? "Turning on…" : "Turn on") {
                    saving = true
                    Task {
                        turning = await model.spadeRequest(["type": "spade.enable", "on": true], failing: "Couldn't turn on Spade")
                        saving = false
                    }
                }
                .buttonStyle(.textAction(.prominent))
                .disabled(saving)
                .accessibilityIdentifier("spade.turnOn")
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.state")
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout).foregroundStyle(AceDesign.Ink.muted)
    }
}

/// A bot's row: its face, its name and when it was last active, then what it does now in its
/// state's colour, or its latest message.
private struct SpadeBotRow: View {
    let model: ClientModel
    let bot: SpadeModel.Bot
    var body: some View {
        QuietSectionRow {
            SpadeBotFace(model: model, face: bot.face, working: bot.working)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    Text(bot.name).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    Spacer(minLength: AceDesign.Space.related)
                    Text(bot.age).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.subtle).monospacedDigit()
                }
                Text(bot.line).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(bot.tone.map { AceTone($0).text } ?? AceDesign.Ink.subtle)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
