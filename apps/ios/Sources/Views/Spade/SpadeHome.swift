import SwiftUI

/// Where Spade's tab goes: a conversation, or a new one.
enum SpadeRoute: Hashable {
    case conversation(String)
    case new
}

/// The Spade tab, as the web's Spade place: "Spade" and New conversation, Spade's state in one
/// sentence while it isn't running (with Turn on while it is off), then its conversations, newest
/// first. A row says Approve while an approval waits on the person, Working while Spade answers
/// in it or a job of its runs, otherwise its age. Spade runs on one machine; with several paired
/// the header's menu picks which one's Spade this is.
struct SpadeHome: View {
    let inbox: MachineInbox
    @AppStorage("ace.spade.machine") private var chosen = ""
    @State private var path: [SpadeRoute] = []

    private var hostId: String {
        inbox.sessions.contains { $0.hostId == chosen } ? chosen : inbox.sessions.first?.hostId ?? ""
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model = inbox.client(hostId) {
                    SpadeList(model: model, open: { path.append(.conversation($0)) }, start: { path.append(.new) })
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
                        Button { path.append(.new) } label: { AceIcon(.notePencil, size: AceDesign.Size.barIcon) }
                            .accessibilityLabel("New conversation")
                            .accessibilityIdentifier("spade.new")
                    }
                }
            }
            .navigationDestination(for: SpadeRoute.self) { route in
                if let model = inbox.client(hostId) {
                    switch route {
                    case .conversation(let id): SpadeConversationView(model: model, conversationId: id)
                    case .new:
                        SpadeConversationView(model: model, conversationId: nil) { id in
                            // The new conversation takes the new page's place, so Back goes to the list.
                            if path.last == .new { path.removeLast() }
                            path.append(.conversation(id))
                        }
                    }
                }
            }
        }
        .background(AceTheme.Colours.background)
    }
}

/// One machine's Spade: its state line, then its conversations.
private struct SpadeList: View {
    let model: ClientModel
    let open: (String) -> Void
    let start: () -> Void
    @State private var turning: SpadeOutcome?
    @State private var saving = false

    private var spade: SpadeModel { model.spade }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if let line = spade.line, !line.ready { stateLine(line) }
                if let failed = turning, !failed.ok {
                    Text([failed.title, failed.message].compactMap(\.self).joined(separator: ". "))
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

    @ViewBuilder private var list: some View {
        if let rows = spade.rows {
            if rows.isEmpty {
                if spade.line?.ready == true {
                    EmptyState(icon: .chatTeardropText, title: "No conversations yet") {
                        Button("New conversation", action: start).buttonStyle(.textAction(.prominent))
                    }
                }
            } else {
                QuietSection {
                    ForEach(rows) { row in
                        Button { open(row.id) } label: { SpadeListRowView(row: row) }
                            .buttonStyle(RowPressStyle())
                            .accessibilityIdentifier("spade.row.\(row.id)")
                    }
                }
            }
        } else if spade.listFailed {
            EmptyState(icon: .warningCircle, title: "Couldn't read Spade's conversations", failed: true) {
                Button("Try again") { model.spadeRefresh() }.buttonStyle(.textAction(.prominent))
            }
        } else if spade.line?.ready == true {
            SkeletonRows(count: 4, label: "Loading conversations")
        }
    }

    /// Spade's state in one sentence, with Turn on while the setting is off.
    private func stateLine(_ line: SpadeModel.Line) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(line.sentence)
                .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                .foregroundStyle(AceDesign.Ink.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
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
}

/// A conversation's row: its name, then Approve, Working or its age.
private struct SpadeListRowView: View {
    let row: SpadeModel.ListRow
    var body: some View {
        QuietSectionRow {
            QuietRowText(title: row.title)
            let tone = AceTone(row.tone)
            if tone == .idle {
                Text(row.label).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.subtle).monospacedDigit()
            } else {
                StatusLabel(word: row.label, tone: tone, glyph: GlyphState(tone: tone), loud: tone == .needsYou, live: tone == .working)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
