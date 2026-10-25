import SwiftUI

/// What a row's swipes, menu and tap do. The inbox owns them; the list only offers them.
struct InboxRowActions {
    let open: (InboxKey) -> Void
    let settle: (ThreadRow, InboxKey) -> Void
    let unsettle: (ThreadRow, InboxKey) -> Void
    let snooze: (InboxKey) -> Void
    let snoozeUntil: (ThreadRow, InboxKey, String) -> Void
    let wake: (ThreadRow, InboxKey) -> Void
    let archive: (ThreadRow, InboxKey) -> Void
}

/// Which folded groups at the end of the list are open.
struct InboxShelves: Equatable { var snoozed = false; var settled = false }

/// The flat task list (DESIGN.md §3, §8): the shared sections merged by rank with no headings,
/// rows separated by space rather than rules, a soft rounded fill on the pressed row, then the
/// Snoozed and Settled shelves. `includes` applies the scope; grouping and wording come from
/// each machine's runtime.
struct InboxList: View {
    @Bindable var inbox: MachineInbox
    let includes: (InboxKey) -> Bool
    /// Whether the scope takes every thread of a machine, so its unloaded threads still count.
    let whole: (String) -> Bool
    @Binding var shelves: InboxShelves
    let actions: InboxRowActions
    /// Opens New thread; nil while every machine is view-only.
    let compose: (() -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    private static let shelved = ["snoozed", "settled"]

    private var sections: [MergedInbox.Section] {
        inbox.merged.sections.compactMap { $0.scoped(includes, whole: whole) }
    }

    var body: some View {
        let sections = sections
        List {
            if !inbox.sessions.isEmpty && inbox.sessions.allSatisfy({ !$0.client.canOperate }) {
                ViewOnlyNote(message: "View only")
                    .accessibilityHint("Pair with View and act to send, archive or snooze.")
                    .inboxRowChrome()
            }
            let live = sections.filter { !Self.shelved.contains($0.key) }
            ForEach(live) { section in
                // One section sorted by hand or by creation needs no heading: the title says it.
                if live.count > 1 || section.key != "threads" {
                    InboxSectionHeading(label: section.label).inboxRowChrome()
                }
                rows(section)
            }
            ForEach(Self.shelved, id: \.self) { key in
                if let section = sections.first(where: { $0.key == key }) {
                    let open = key == "snoozed" ? shelves.snoozed : shelves.settled
                    InboxShelf(label: section.label, count: section.count, expanded: open) {
                        withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) {
                            if key == "snoozed" { shelves.snoozed.toggle() } else { shelves.settled.toggle() }
                        }
                    }
                    .accessibilityIdentifier("inbox.\(key)")
                    .inboxRowChrome()
                    .padding(.top, AceTheme.Spacing.sm)
                    if open { rows(section) }
                }
            }
            if !inbox.merged.more.isEmpty {
                Button { for id in inbox.merged.more { inbox.client(id)?.loadOlderThreads() } } label: {
                    Text("Show older threads").meta()
                        .padding(.horizontal, AceTheme.Spacing.md)
                        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                }
                .buttonStyle(.row)
                .accessibilityIdentifier("inbox.more")
                .inboxRowChrome()
            }
            if sections.isEmpty { emptyState.inboxRowChrome() }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(surface)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.vertical, AceTheme.Spacing.xs, for: .scrollContent)
        .onAppear { if !sections.isEmpty { InboxList.traceRows(sections) } }
        .onChange(of: sections.isEmpty) { _, empty in if !empty { InboxList.traceRows(sections) } }
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
                        .inboxRowRule()
                        .inboxRowChrome()
                }
            }
        } else {
            ForEach(section.rows, id: \.self) { key in
                InboxThreadCell(inbox: inbox, key: key, section: section.key, actions: actions)
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !inbox.anyLoaded || !inbox.allReady {
            if inbox.sessions.contains(where: { ["fatal", "offline", "reconnecting"].contains($0.client.connection) }) {
                EmptyState(icon: .wifiSlash, title: inbox.showsMachineNames ? "Can't reach your machines" : "Can't reach your machine",
                           line: "Your threads appear once it's back.") {
                    Button("Retry") { for session in inbox.sessions { session.client.retry() } }
                }
                .padding(.top, 120)
            } else {
                InboxSkeleton()
            }
        } else {
            EmptyState(icon: .tray, title: "No threads yet") {
                if let compose { Button("New thread", action: compose).accessibilityIdentifier("inbox.empty.compose") }
            }
            .padding(.top, 120)
        }
    }
}

/// The list while the first rows load (DESIGN.md §3 "Loading"): skeleton pills in the shape of
/// rows, never a page spinner.
private struct InboxSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xl) {
            ForEach(0..<5, id: \.self) { index in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    pill(width: 96, height: 11)
                    pill(width: index.isMultiple(of: 2) ? 220 : 180, height: 15)
                    pill(width: 120, height: 11)
                }
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading threads")
    }
    private func pill(width: CGFloat, height: CGFloat) -> some View {
        AceShape.capsule
            .fill(AceTheme.Colours.fill)
            .frame(width: width, height: height)
    }
}

extension View {
    /// The task list's row chrome: inset 8pt from the screen edge, 4pt between rows, the list's
    /// surface behind, and no rules (DESIGN.md: nothing in the task list is ruled).
    func inboxRowChrome() -> some View { modifier(InboxRowChrome()) }
}

extension View {
    /// A hairline under a thread row, from the title's leading edge to the row's end, as the
    /// system's lists draw them.
    func inboxRowRule() -> some View {
        self.listRowSeparator(.visible, edges: .bottom)
            .listRowSeparatorTint(AceTheme.Colours.separator)
            .alignmentGuide(.listRowSeparatorLeading) { _ in AceTheme.Spacing.md * 2 + 10 }
            .alignmentGuide(.listRowSeparatorTrailing) { $0.width - AceTheme.Spacing.md }
    }
}

/// A section's name over its rows: Needs you, Working, Done.
struct InboxSectionHeading: View {
    let label: String
    var body: some View {
        Text(label)
            .aceFont(AceTheme.TypeStyle(size: 13, lineHeight: 17, weight: 600, tracking: 0), relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .padding(.top, AceTheme.Spacing.lg)
            .padding(.bottom, AceTheme.Spacing.xxs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct InboxRowChrome: ViewModifier {
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    func body(content: Content) -> some View {
        content
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xxs, leading: AceTheme.Spacing.sm,
                                      bottom: AceTheme.Spacing.xxs, trailing: AceTheme.Spacing.sm))
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
    let section: String
    let actions: InboxRowActions
    /// The thread open beside the list.
    @Environment(\.openThreadRow) private var open

    var body: some View {
        if let row = inbox.row(key) { threadRow(row) }
    }

    private func threadRow(_ row: ThreadRow) -> some View {
        let snoozed = section == "snoozed"
        let settled = section == "settled"
        // A view-only grant is per machine: only that machine's rows lose their actions.
        let canOperate = inbox.client(key.machineId)?.canOperate ?? false
        // The daemon refuses to settle a tree that still runs.
        let canSettle = canOperate && !settled && row.state != "working"
        return Button { actions.open(key) } label: {
            InboxThreadRow(row: row, snoozed: snoozed, machine: inbox.showsMachineNames ? inbox.name(key.machineId) : nil)
        }
        .buttonStyle(RowPressStyle(selected: open == key))
        .accessibilityAddTraits(open == key ? .isSelected : [])
        .accessibilityIdentifier(inbox.showsMachineNames ? "thread.\(key.machineId).\(row.id)" : "thread.\(row.id)")
        .inboxRowRule()
        .inboxRowChrome()
        // Neutral swipe fills: status hues belong to status only.
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if canOperate {
                if settled {
                    Button("Unsettle", ace: .arrowUUpLeft) { actions.unsettle(row, key) }.tint(Color(uiColor: .systemGray))
                } else if canSettle {
                    Button("Settle", ace: .check) { actions.settle(row, key) }.tint(Color(uiColor: .systemGray))
                }
                if snoozed {
                    Button("Wake", ace: .sun) { actions.wake(row, key) }.tint(Color(uiColor: .systemGray2))
                } else if !settled {
                    Button("Snooze", ace: .clock) { actions.snooze(key) }.tint(Color(uiColor: .systemGray2))
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if canOperate { Button("Archive", ace: .archive) { actions.archive(row, key) }.tint(Color(uiColor: .systemGray2)) }
        }
        .contextMenu {
            if canOperate {
                if settled { Button("Unsettle", ace: .arrowUUpLeft) { actions.unsettle(row, key) } }
                else if canSettle { Button("Settle", ace: .check) { actions.settle(row, key) } }
                if snoozed { Button("Wake", ace: .sun) { actions.wake(row, key) } }
                else if !settled {
                    Menu {
                        ForEach(inbox.merged.snooze) { option in Button(option.label) { actions.snoozeUntil(row, key, option.id) } }
                    } label: { Label("Snooze", ace: .clock) }
                }
                Button("Archive", ace: .archive) { actions.archive(row, key) }
            }
        }
    }
}
