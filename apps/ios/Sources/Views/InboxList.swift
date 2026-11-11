import SwiftUI

/// What a row's swipes, menu and tap do. The inbox owns them; the list only offers them.
struct InboxRowActions {
    let open: (InboxKey) -> Void
    /// Whether a row tap now opens anything: just after a row action it doesn't (`RowTapGuard`).
    let accepts: () -> Bool
    let settle: (ThreadRow, InboxKey) -> Void
    let unsettle: (ThreadRow, InboxKey) -> Void
    let snooze: (InboxKey) -> Void
    let snoozeUntil: (ThreadRow, InboxKey, String) -> Void
    let wake: (ThreadRow, InboxKey) -> Void
    let archive: (ThreadRow, InboxKey) -> Void
    /// Pin (leading Pinned) or unpin.
    let pin: (ThreadRow, InboxKey, Bool) -> Void
    /// Ask for the row's new name.
    let rename: (InboxKey) -> Void
    /// Put the row at an index among the other rows of its section, as shown.
    let move: (InboxKey, MergedInbox.Section, Int) -> Void
    /// The rest of a thread's actions, by its shared menu ids (`ThreadActionItems`).
    let organizer: ThreadOrganizer
    /// Starts picking threads for a bulk action, with this one picked.
    let select: (InboxKey) -> Void
}

/// What the list holds, in order: which rows are in which group of the open tab. Equal, for the
/// animation, when nothing moved, when the person switched tabs, or when the whole list was
/// replaced (the first rows, or the live list taking over from the saved one): those arrive at
/// once, never as a crossfade of every row over itself.
private struct Membership: Equatable {
    let keys: [String]
    let rows: [[InboxKey]]
    let tab: String
    init(sections: [MergedInbox.Section], tab: String) {
        keys = sections.map(\.key)
        rows = sections.map(\.rows)
        self.tab = tab
    }
    /// More rows than this joining or leaving at once is a replacement, not a move.
    static let animatedChange = 8
    static func == (lhs: Membership, rhs: Membership) -> Bool {
        if lhs.tab != rhs.tab { return true }
        if lhs.keys == rhs.keys && lhs.rows == rhs.rows { return true }
        let old = Set(lhs.rows.joined()), new = Set(rhs.rows.joined())
        if old.isEmpty || new.isEmpty { return true }
        return old.symmetricDifference(new).count > animatedChange
    }
}

/// The flat task list (DESIGN.md §3, §8): the open Threads tab's shared sections merged by rank
/// with no headings, rows separated by space rather than rules, a soft rounded fill on the
/// pressed row. `includes` applies the scope; grouping, the tab each section is in and the
/// wording come from each machine's runtime.
struct InboxList: View {
    @Bindable var inbox: MachineInbox
    let includes: (InboxKey) -> Bool
    /// Whether the scope takes every thread of a machine, so its unloaded threads still count.
    let whole: (String) -> Bool
    /// The open Threads tab: "inbox", "snoozed" or "settled".
    let tab: String
    /// A row to bring into view as soon as it is among the open tab's rows (an Undo's), then
    /// cleared. One in another tab waits: that tab is not where it is coming back to.
    @Binding var reveal: InboxKey?
    let actions: InboxRowActions
    /// Opens New thread; nil while every machine is view-only.
    let compose: (() -> Void)?
    /// Opens pairing while no computer is paired; nil while that isn't known yet.
    var pair: (() -> Void)?
    /// The threads picked while the list is in its Select mode (nil outside it).
    var selection: Binding<Set<InboxKey>>? = nil
    /// The list's first row, under the large title (Inbox, Snoozed and Settled): it scrolls with
    /// the rows, so the system collapses the title with nothing pinned beneath it.
    var header: AnyView? = nil
    @Environment(\.onSidebarGlass) private var onGlass
    /// The needs-you run is open.
    @State private var running = false
    /// The run's pages, here so they outlive any redraw of the run's screen.
    @State private var run = NeedsRunQueue()
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    /// Where the list is scrolled: a tab switch takes it back to its very top, the large title
    /// open again over the tabs.
    @State private var position = ScrollPosition()

    private var sections: [MergedInbox.Section] {
        inbox.merged.sections.compactMap { $0.scoped(includes, whole: whole) }
    }

    var body: some View {
        let sections = sections
        let shown = sections.filter { $0.tab == tab }
        ScrollViewReader { proxy in
            List(selection: selection) {
                if let header {
                    header
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(surface)
                        .listRowSeparator(.hidden)
                        .selectionDisabled()
                }
                if !inbox.sessions.isEmpty && inbox.sessions.allSatisfy({ !$0.client.canOperate }) {
                    ViewOnlyNote(message: "View only")
                        .accessibilityHint("Pair with View and act to send, archive or snooze.")
                        .inboxRowChrome()
                        .selectionDisabled()
                }
                if tab == "inbox", selection == nil {
                    ForEach(inbox.sessions, id: \.hostId) { session in
                        ForEach(session.client.outside.screen) { use in
                            OutsideScreenLine(client: session.client, use: use,
                                              machine: inbox.names[session.hostId] ?? "This machine",
                                              named: inbox.showsMachineNames)
                                .inboxRowChrome()
                                .selectionDisabled()
                        }
                    }
                }
                if tab == "inbox", selection == nil, let words = NeedWords.count(needs(shown).count) {
                    NeedsYouLine(words: words) {
                        run = NeedsRunQueue(needs(shown))
                        running = true
                    }
                        .inboxRowChrome()
                        .selectionDisabled()
                }
                // One flat list in the shared order, as the desktop's tabs: no headings. Pinned
                // and the rest stay separate sections only so pins can be dragged among themselves.
                ForEach(shown) { section in rows(section) }
                // Older settled threads the daemons hold back page in where they belong.
                if tab == "settled" && !inbox.merged.more.isEmpty {
                    Button { for id in inbox.merged.more { inbox.client(id)?.loadOlderThreads() } } label: {
                        Text("Show older threads").meta()
                            .padding(.horizontal, AceDesign.Space.row)
                            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("inbox.more")
                    .inboxRowChrome()
                    .selectionDisabled()
                }
                if sections.isEmpty {
                    emptyState.inboxRowChrome().selectionDisabled()
                } else if shown.isEmpty, let empty = inbox.merged.tabs.first(where: { $0.id == tab }) {
                    TabEmpty(tab: empty).inboxRowChrome().selectionDisabled()
                }
            }
            .listStyle(.plain)
            .scrollPosition($position)
            .scrollContentBackground(.hidden)
            .background(surface)
            .environment(\.defaultMinListRowHeight, 0)
            // Select mode is the system's own: a check circle on each row, two-finger drag and
            // (on iPad) Shift or Command with the pointer or arrows to pick several.
            .environment(\.editMode, .constant(selection == nil ? .inactive : .active))
            .contentMargins(.vertical, AceDesign.Space.tight, for: .scrollContent)
            // Rows joining, leaving or moving between groups take the list's own insert, remove
            // and move animations on the system's spring, keyed on membership alone, so a row's
            // own text changing never animates the list.
            .animation(.default, value: Membership(sections: shown, tab: tab))
            .onAppear { if !sections.isEmpty { InboxList.traceRows(sections) } }
            .onChange(of: sections.isEmpty) { _, empty in if !empty { InboxList.traceRows(sections) } }
            // Each tab opens at its top, the tabs in view. The new tab's rows are read when the
            // change lands, never the rows of the tab just left.
            .onChange(of: tab) { _, now in
                if header != nil {
                    // After the new tab's rows are in: scrolled now, the list's own repositioning
                    // for the swapped rows wins and it lands at the far end.
                    DispatchQueue.main.async { position.scrollTo(edge: .top) }
                } else if let first = sections.filter({ $0.tab == now }).first(where: { $0.key != "unsent" })?.rows.first {
                    proxy.scrollTo(first, anchor: .top)
                }
            }
            .onChange(of: revealable(shown), initial: true) { _, key in
                guard let key else { return }
                reveal = nil
                withAnimation { proxy.scrollTo(key, anchor: .center) }
            }
            .fullScreenCover(isPresented: $running) {
                NeedsRun(inbox: inbox, live: { needs(sections.filter { $0.tab == "inbox" }) }, queue: $run) { key in
                    running = false
                    actions.open(key)
                }
            }
        }
    }
    /// Everything waiting on the person in the open tab's rows, in the list's order: each
    /// request, and each thread that needs the person with no request to answer here.
    private func needs(_ shown: [MergedInbox.Section]) -> [NeedsRunQueue.Entry] {
        shown.filter { $0.key != "unsent" }.flatMap(\.rows).flatMap { key -> [NeedsRunQueue.Entry] in
            let asks = inbox.client(key.machineId)?.needsYou(key.id) ?? []
            if !asks.isEmpty { return asks.map { NeedsRunQueue.Entry(thread: key, request: $0.id) } }
            return inbox.row(key)?.look?.level == "needs-you" ? [NeedsRunQueue.Entry(thread: key, request: nil)] : []
        }
    }
    /// The row to reveal, once the open tab lists it.
    private func revealable(_ shown: [MergedInbox.Section]) -> InboxKey? {
        guard let reveal else { return nil }
        let listed = shown.contains { $0.rows.contains(reveal) }
        return listed ? reveal : nil
    }
    /// Marks the first time this process draws inbox rows, for launch timing.
    private static var tracedRows = false
    private static func traceRows(_ sections: [MergedInbox.Section]) {
        guard !tracedRows else { return }
        tracedRows = true
        LaunchTrace.mark("inbox.rowsOnScreen", "\(sections.reduce(0) { $0 + $1.rows.count }) rows")
    }

    @ViewBuilder private func rows(_ section: MergedInbox.Section) -> some View {
        if section.key == "unsent" {
            ForEach(section.rows, id: \.self) { key in
                if let entry = inbox.pending(key) {
                    let thread = InboxKey(machineId: key.machineId, id: entry.threadId)
                    Button { actions.open(thread) } label: { InboxUnsentRow(entry: entry, thread: inbox.row(thread)) }
                        .buttonStyle(.row).accessibilityIdentifier("unsent.\(key.id)")
                        .inboxRowChrome()
                        .selectionDisabled()
                }
            }
        } else {
            let movable = inbox.movable(section)
            ForEach(section.rows, id: \.self) { key in
                InboxThreadCell(inbox: inbox, key: key, section: section, movable: movable, actions: actions,
                                selecting: selection != nil).id(key).tag(key)
            }
            // The system's own drag to reorder: press and hold a row, then move it. Pinned rows
            // always; the Threads list only when it is sorted by hand.
            .onMove(perform: movable && selection == nil ? { from, to in
                guard let source = from.first, source < section.rows.count else { return }
                let key = section.rows[source]
                // `to` counts the moving row; the shared rules count only the others.
                actions.move(key, section, to > source ? to - 1 : to)
            } : nil)
        }
    }

    @ViewBuilder private var emptyState: some View {
        if inbox.sessions.isEmpty, let pair {
            NoComputerPaired(pair: pair).padding(.top, AceDesign.Space.section * 2)
        } else if !inbox.anyLoaded || !inbox.allReady {
            if let asking = inbox.sessions.first(where: { $0.client.connection == "fatal" && $0.client.machineCodeAsk != nil }) {
                // Reachable and waiting for its code: say so, and open the code prompt again.
                EmptyState(icon: .lock, title: "Enter the machine code",
                           line: asking.client.machineCodeAsk?.message(lockedUntil: asking.client.machineCodeLockedUntil) ?? "") {
                    if asking.client.machineCodeAsk?.canEnter == true {
                        Button("Enter code") { asking.client.machineCodeDeferred = false }
                    }
                }
                .padding(.top, AceDesign.Space.section * 2)
            } else if inbox.sessions.contains(where: { ["fatal", "offline", "reconnecting"].contains($0.client.connection) }) {
                EmptyState(icon: .wifiSlash, title: inbox.showsMachineNames ? "Can't reach your machines" : "Can't reach your machine",
                           line: "Your threads appear once it's back.") {
                    Button("Retry") { for session in inbox.sessions { session.client.retry() } }
                }
                .padding(.top, AceDesign.Space.section * 2)
            } else {
                SkeletonRows(label: "Loading threads")
            }
        } else {
            EmptyState(icon: .tray, title: "No threads yet") {
                if let compose { Button("New thread", action: compose).accessibilityIdentifier("inbox.empty.compose") }
            }
            .padding(.top, AceDesign.Space.section * 2)
        }
    }
}

/// An empty tab while other threads exist: the shared empty state with its runtime's words
/// ("Inbox zero", "Nothing snoozed"), as the desktop's panel says them.
private struct TabEmpty: View {
    let tab: MergedInbox.Tab
    var body: some View {
        EmptyState(systemImage: tab.id == "snoozed" ? "moon.zzz" : tab.id == "settled" ? "checkmark.circle" : "tray",
                   title: tab.empty, line: tab.emptyLine)
            .padding(.top, AceDesign.Space.section * 2)
            .accessibilityIdentifier("threads.empty.\(tab.id)")
    }
}


extension View {
    /// The task list's row chrome: inset 8pt from the screen edge, 4pt between rows, the list's
    /// surface behind, and no rules (DESIGN.md: nothing in the task list is ruled).
    func inboxRowChrome() -> some View { modifier(InboxRowChrome()) }
}

private struct InboxRowChrome: ViewModifier {
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    func body(content: Content) -> some View {
        content
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Size.listInset,
                                      bottom: AceTheme.Spacing.none, trailing: AceDesign.Size.listInset))
            .listRowBackground(surface)
            .listRowSeparator(.hidden)
    }
}

extension EnvironmentValues {
    /// The inbox's lists sit on the iPadOS 26 sidebar's glass: they draw nothing behind their
    /// rows, so the panel's own material shows through as the system's sidebars do.
    @Entry var onSidebarGlass = false
}

/// One thread's row in the list. It reads its own row, so a change to one thread redraws that
/// row alone; the list itself redraws only when rows join, leave or move.
private struct InboxThreadCell: View {
    let inbox: MachineInbox
    let key: InboxKey
    let section: MergedInbox.Section
    /// Whether rows here move by hand (Pinned, or Threads sorted by hand).
    let movable: Bool
    let actions: InboxRowActions
    /// In Select mode a tap picks the row instead of opening it, and it has no swipes.
    var selecting = false
    /// The thread open beside the list.
    @Environment(\.openThreadRow) private var open
    /// Row swipes taken, for their haptic.
    @State private var swipes = 0
    private func swiped() { swipes += 1 }

    var body: some View {
        if let row = inbox.row(key) { threadRow(row) }
    }

    private func threadRow(_ row: ThreadRow) -> some View {
        // A pinned row shows under Pinned but keeps its own state's actions and words.
        let group = row.group ?? section.key
        let snoozed = group == "snoozed"
        let settled = group == "settled"
        let pinned = row.pinned == true
        let position = section.rows.firstIndex(of: key)
        let canMoveUp = movable && (position ?? 0) > 0
        let canMoveDown = movable && position.map { $0 < section.rows.count - 1 } == true
        // A view-only grant is per machine: only that machine's rows lose their actions.
        let canOperate = inbox.client(key.machineId)?.canOperate ?? false
        // The daemon refuses to settle a tree that still runs.
        let canSettle = canOperate && !settled && row.state != "working"
        let model = inbox.client(key.machineId)
        let asks = selecting ? [] : model?.needsYou(row.id) ?? []
        let need = model.flatMap { model in
            asks.isEmpty ? nil : InboxNeedLine(requests: asks, total: model.needsCount(row.id), model: model, threadId: row.id) { actions.open(key) }
        }
        // Snoozed and Settled draw each thread as one line, as the web's do; Inbox in three.
        let label = Group {
            if section.tab == "inbox" {
                InboxThreadRow(row: row, snoozed: snoozed, machine: inbox.mark(key.machineId),
                               project: inbox.projectLook(key, workspace: row.workspaceId), need: need)
            } else {
                let look = InboxThreadRow.look(of: row)
                InboxLineRow(row: row, end: .work,
                             wake: snoozed && look.level != "needs-you" ? row.snoozedUntil.map(InboxRowLine.wake) : nil)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(InboxThreadRow.spoken(row, look, snoozed: snoozed, need: need))
            }
        }
        // One view in both modes, so entering Select mode only slides the check circles in: in
        // it the list picks the row, and the button underneath takes no taps.
        return Button { actions.open(key) } label: { label }
            .buttonStyle(RowPressStyle(selected: open == key))
            .allowsHitTesting(!selecting)
        .accessibilityAddTraits(open == key ? .isSelected : [])
        .accessibilityIdentifier(inbox.showsMachineNames ? "thread.\(key.machineId).\(row.id)" : "thread.\(row.id)")
        .inboxRowChrome()
        // Neutral swipe fills: status hues belong to status only.
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if canOperate && !selecting {
                if settled {
                    Button("Unsettle", ace: .arrowUUpLeft) { swiped(); actions.unsettle(row, key) }.tint(Color(uiColor: .systemGray))
                } else if canSettle {
                    Button("Settle", ace: .check) { swiped(); actions.settle(row, key) }.tint(Color(uiColor: .systemGray))
                }
                if snoozed {
                    Button("Wake", ace: .sun) { swiped(); actions.wake(row, key) }.tint(Color(uiColor: .systemGray2))
                } else if !settled {
                    Button("Snooze", ace: .clock) { swiped(); actions.snooze(key) }.tint(Color(uiColor: .systemGray2))
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            // Pin alone, as Mail's leading swipe; Rename and Archive are in the long-press menu.
            if canOperate && !selecting { pinButton(row, pinned).tint(Color(uiColor: .systemGray)) }
        }
        .sensoryFeedback(AceDesign.Haptic.rowAction, trigger: swipes)
        .accessibilityActions {
            if let model, let request = asks.first, request.kind == "approval", model.approvalSubmissions[request.id] == nil {
                let words = NeedActions(request: request, model: model, threadId: row.id, open: { actions.open(key) }, review: {}, decided: {})
                ForEach(words.row) { word in Button(word.label, action: word.run) }
            }
            if canOperate {
                if canMoveUp { Button("Move up") { step(-1) } }
                if canMoveDown { Button("Move down") { step(1) } }
            }
        }
        // A long press previews the thread above its actions, as the web's hover card and menu
        // do. Every action here is also in the open thread's ⋯ and in Select mode's bar.
        .contextMenu {
            if !selecting {
                InboxRowMenu(inbox: inbox, key: key, canOperate: canOperate, actions: actions,
                             canMoveUp: canMoveUp, canMoveDown: canMoveDown, step: step)
            }
        } preview: {
            // The card names the machine always, as the desktop's names "This machine".
            ThreadPreview(row: row, machine: inbox.mark(key.machineId)
                              ?? MachineMark(name: inbox.name(key.machineId), glyph: inbox.client(key.machineId)?.machineGlyph ?? .laptop),
                          project: inbox.projectLook(key, workspace: row.workspaceId))
        }
    }

    private func pinButton(_ row: ThreadRow, _ pinned: Bool) -> some View {
        Button(pinned ? "Unpin" : "Pin", ace: pinned ? .pushPinSlash : .pushPin) { swiped(); actions.pin(row, key, !pinned) }
    }
    /// One place up or down among the section's rows as shown.
    private func step(_ by: Int) {
        guard let position = section.rows.firstIndex(of: key) else { return }
        actions.move(key, section, position + by)
    }
}

/// A row's long-press menu. Its own view, so reading the machines' shared menu words redraws
/// only the open menu, never every row when the layout changes.
private struct InboxRowMenu: View {
    let inbox: MachineInbox
    let key: InboxKey
    let canOperate: Bool
    let actions: InboxRowActions
    let canMoveUp: Bool
    let canMoveDown: Bool
    let step: (Int) -> Void

    var body: some View {
        if let row = inbox.row(key) {
            if canOperate {
                let merged = inbox.merged
                ThreadActionItems(key: key, row: row, labels: merged.menuLabels, sections: merged.menuSections,
                                  snoozeOptions: merged.snooze, organizer: actions.organizer,
                                  extra: canMoveUp || canMoveDown ? AnyView(moves) : nil,
                                  rename: { actions.rename(key) })
                Section { Button("Select", ace: .checkCircle) { actions.select(key) }.accessibilityIdentifier("thread.action.select") }
            } else {
                Button("Copy link", ace: .link) { actions.organizer.perform(key, "copy-link") }
            }
        }
    }
    @ViewBuilder private var moves: some View {
        if canMoveUp { Button("Move up", ace: .arrowUp) { step(-1) } }
        if canMoveDown { Button("Move down", ace: .arrowDown) { step(1) } }
    }
}
