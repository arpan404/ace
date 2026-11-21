import SwiftUI

/// What the ⋯ menu shows, read from the model when the thread's view redraws. The menu compares
/// these, never the model's own state: a system menu rebuilt while open drops the item under
/// the finger, and the thread's row changes many times a second while it works.
struct ThreadMenuFacts: Equatable {
    /// The thread's row, for its organize actions (`ThreadActionItems`).
    struct Organize: Equatable {
        let key: InboxKey
        let row: ThreadRow
        let labels: [String: String]
        let sections: [String: String]
        let snooze: [InboxLayout.SnoozeOption]
        /// The same actions under the same words; the rest of the row is not compared.
        static func == (lhs: Organize, rhs: Organize) -> Bool {
            lhs.key == rhs.key && lhs.row.menu == rhs.row.menu && lhs.row.group == rhs.row.group
                && lhs.row.snoozeEvents == rhs.row.snoozeEvents && lhs.labels == rhs.labels
                && lhs.sections == rhs.sections && lhs.snooze == rhs.snooze
        }
    }
    var canOperate = false
    var archived = false
    var forkLast = false
    var hasParent = false
    var canStop = false
    var stopping = false
    /// Continue on another machine: shown while machines are linked, enabled unless its work
    /// already moved (a working thread moves live, ADR 0191).
    var continueOn: Bool? = nil
    /// Why it waits, under it.
    var continueBlocked: String? = nil
    var snooze: [InboxLayout.SnoozeOption] = []
    /// Nil until the thread's row is held: Snooze and Archive then run on the thread directly.
    var organize: Organize? = nil

    @MainActor static func of(model: ClientModel, thread: ThreadModel, archived: Bool) -> ThreadMenuFacts {
        let screen = thread.screen
        var facts = ThreadMenuFacts(canOperate: model.canOperate, archived: archived,
                                    forkLast: screen.transitions?.lastTurn == true, hasParent: screen.transitions?.parent != nil,
                                    canStop: screen.controls?.canStop == true, stopping: screen.stopping,
                                    snooze: model.inboxLayout.snooze)
        if model.canOperate, model.transfers.linked, !archived {
            let state = model.transfers.thread(thread.id)
            facts.continueOn = state?.canContinue == true
            facts.continueBlocked = state?.blocked
        }
        if let row = model.inbox[thread.id], let hostId = model.hostId, model.canOperate {
            facts.organize = Organize(key: InboxKey(machineId: hostId, id: thread.id), row: row,
                                      labels: model.inboxLayout.menuLabels ?? [:], sections: model.inboxLayout.menuSections ?? [:],
                                      snooze: model.inboxLayout.snooze)
        }
        return facts
    }
}

/// The ⋯ menu, one system menu: the page not showing (a phone with changes), the thread's
/// screens as one row (`ThreadDestination.menuScreens`), then Agents and the conversation, the thread's
/// tools and how it is organized, each its own section, so every action is one tap away. It
/// redraws only when what it shows changes (`==`).
struct ThreadMenu: View, Equatable {
    let model: ClientModel
    let threadId: String
    let facts: ThreadMenuFacts
    /// The thread's title, as Continue on… names it.
    var title = ""
    let open: (ThreadDestination) -> Void
    /// Where `open` sends a tool now (the iPad side panel, or over the thread): it is part of
    /// what the menu is, so a change rebuilds the menu with a fresh `open`.
    var opensInPanel = false
    /// The thread's pages on a phone; nil beside the side panel.
    var pages: ThreadPages? = nil
    var shownPage: ThreadPageKind = .chat
    /// Leaves the thread after it was snoozed or archived.
    let leave: () -> Void
    @Environment(\.threadOrganizer) private var organizer

    var body: some View {
        Menu {
            items
        } label: {
            // A plain glyph, so iOS draws the bar button at its own size.
            Image(bar: .dotsThree, weight: .bold)
                .foregroundStyle(AceTheme.Colours.foreground)
        }
        .menuOrder(.fixed)
        .barGlyph()
        .accessibilityShowsLargeContentViewer {
            Image(ace: .dotsThree, weight: .bold)
            Text("Thread options")
        }
        .accessibilityLabel("Thread options")
        .accessibilityIdentifier("thread.menu")
    }

    @ViewBuilder private var items: some View {
        if let page = ThreadDestination.menuPage(pages: pages, shown: shownPage) { pageItem(page) }
        let row = ThreadDestination.menuScreens(pages: pages)
        if !row.isEmpty {
            ControlGroup { ForEach(row, id: \.self, content: screenItem) }
        }
        conversation
        tools
        organize
        if facts.canOperate, facts.canStop {
            Section {
                Button("Stop all agents", ace: .stopCircle, role: .destructive) { model.stopTree() }
                    .disabled(facts.stopping)
                    .accessibilityIdentifier("thread.stopAll")
            }
        }
    }

    /// Chat or Changes, whichever isn't showing: Changes with its file count under it.
    private func pageItem(_ page: ThreadDestination) -> some View {
        let kind: ThreadPageKind = page == .changes ? .changes : .chat
        let files = kind == .changes ? pages?.changedFiles ?? 0 : 0
        return Section {
            Button { open(page) } label: {
                Text(kind.title)
                if files > 0 { Text(files == 1 ? "1 file" : "\(files) files") }
                Image(ace: kind.icon)
            }
            .accessibilityLabel(pages?.label(of: kind) ?? kind.title)
            .accessibilityIdentifier("thread.\(kind.rawValue)")
        }
    }

    @ViewBuilder private func screenItem(_ destination: ThreadDestination) -> some View {
        switch destination {
        case .changes: item("Changes", .plusMinus, "thread.changes", destination)
        case .files: item("Files", .folder, "thread.files", destination)
        case .terminal: item("Terminal", .terminalWindow, "thread.terminal", destination)
        case .browser: item("Browser", .compass, "thread.browser", destination)
        case .agents: item("Agents", .treeStructure, "thread.agents", destination)
        default: EmptyView()
        }
    }

    private func item(_ title: String, _ icon: AceIcon.Name, _ id: String, _ destination: ThreadDestination) -> some View {
        Button(title, ace: icon) { open(destination) }.accessibilityIdentifier(id)
    }

    /// What can be done with the conversation itself.
    @ViewBuilder private var conversation: some View {
        Section {
            ForEach(ThreadDestination.menuLeads(pages: pages), id: \.self, content: screenItem)
            item("Find in thread", .magnifyingGlass, "thread.search", .search)
            item("Turns", .listBullets, "thread.turns", .turns)
            item("Attachments", .paperclip, "thread.attachments", .attachments)
        }
        if facts.canOperate, !facts.archived {
            Section {
                item("Rename…", .pencilSimple, "thread.menu.rename", .rename)
                if facts.forkLast { item("Fork from the last turn", .gitFork, "thread.forkLast", .forkLast) }
                if facts.hasParent { item("Bring back to parent…", .gitMerge, "thread.merge", .merge) }
            }
        }
    }

    /// The thread's tools that aren't screens: what the phone keeps, runs and opens elsewhere.
    @ViewBuilder private var tools: some View {
        Section {
            item("Summary", .listChecks, "thread.summary", .summary)
            // On a phone the agent tree is in the row of screens above.
            if pages == nil { item("Agent tree", .treeStructure, "thread.agents", .agents) }
            item("Work", .gitBranch, "thread.work", .work)
            item("Run and preview…", .play, "thread.scripts", .scripts)
            item("Logs", .scroll, "thread.logs", .logs)
        }
        Section {
            item("Devices", .deviceMobile, "thread.devices", .devices)
            item("Computer use", .aceComputerUse, "thread.computer", .computer)
            item("Skills and tools", .wrench, "thread.tools", .tools)
            OpenOnHostMenu(model: model, target: HostOpenTarget(threadId: threadId)) {
                Label("Open in…", ace: .arrowSquareOut)
            }
            .accessibilityIdentifier("thread.openIn")
            Button("Reload from machine", ace: .arrowClockwise) { model.reloadFromMachine() }
                .accessibilityIdentifier("thread.reload")
        }
    }

    /// Continue on, then the row's own actions (read, pin, snooze, settle, archive), or Snooze
    /// and Archive on the thread itself while no row is held.
    @ViewBuilder private var organize: some View {
        if let ready = facts.continueOn {
            Section {
                Button { model.continueOn(threadId: threadId, title: title) } label: {
                    Text("Continue on…")
                    if !ready, let why = facts.continueBlocked { Text(why) }
                    Image(ace: .desktop)
                }
                .disabled(!ready)
                .accessibilityIdentifier("thread.continueOn")
            }
        }
        if let organizer, let held = facts.organize {
            ThreadActionItems(key: held.key, row: held.row, labels: held.labels, sections: held.sections,
                              snoozeOptions: held.snooze, organizer: leaving(organizer))
        } else if facts.canOperate {
            Section {
                if !facts.snooze.isEmpty {
                    Menu {
                        SnoozeChoiceButtons(choices: SnoozeChoice.list(times: facts.snooze, row: nil)) { preset in
                            Task { if await model.snooze(threadId, preset: preset) { leave() } }
                        }
                    } label: { Label("Snooze", ace: .bellSimpleZ) }
                }
                if !facts.archived {
                    // Archive is undone from the archive, so it is not drawn as destructive.
                    Button("Archive", ace: .archive) {
                        Task { if await model.archive(threadId) { leave() } }
                    }
                    .accessibilityIdentifier("thread.action.archive")
                }
            }
        }
    }

    /// Archiving or snoozing the open thread leaves it.
    private func leaving(_ organizer: ThreadOrganizer) -> ThreadOrganizer {
        ThreadOrganizer(perform: { key, id in
                            organizer.perform(key, id)
                            if id == "archive" { leave() }
                        },
                        snooze: { key, preset in organizer.snooze(key, preset); leave() },
                        wake: organizer.wake)
    }

    nonisolated static func == (lhs: ThreadMenu, rhs: ThreadMenu) -> Bool {
        lhs.model === rhs.model && lhs.threadId == rhs.threadId && lhs.facts == rhs.facts && lhs.title == rhs.title
            && lhs.opensInPanel == rhs.opensInPanel && lhs.pages == rhs.pages && lhs.shownPage == rhs.shownPage
    }
}
