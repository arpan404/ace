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
    @Binding var shelves: InboxShelves
    let actions: InboxRowActions
    /// Opens New thread; nil while every machine is view-only.
    let compose: (() -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let shelved = ["snoozed", "settled"]

    private var sections: [MergedInbox.Section] {
        inbox.merged.sections.compactMap { section in
            let rows = section.rows.filter(includes)
            return rows.isEmpty ? nil : MergedInbox.Section(key: section.key, label: section.label, rows: rows)
        }
    }

    var body: some View {
        let sections = sections
        List {
            if !inbox.sessions.isEmpty && inbox.sessions.allSatisfy({ !$0.client.canOperate }) {
                ViewOnlyNote(message: "View only")
                    .accessibilityHint("Pair with View and act to send, archive or snooze.")
                    .inboxRowChrome()
            }
            ForEach(sections.filter { !Self.shelved.contains($0.key) }) { section in
                rows(section)
            }
            ForEach(Self.shelved, id: \.self) { key in
                if let section = sections.first(where: { $0.key == key }) {
                    let open = key == "snoozed" ? shelves.snoozed : shelves.settled
                    InboxShelf(label: section.label, count: section.rows.count, expanded: open) {
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
        .background(AceTheme.Colours.background)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.vertical, AceTheme.Spacing.xs, for: .scrollContent)
    }

    @ViewBuilder private func rows(_ section: MergedInbox.Section) -> some View {
        if section.key == "unsent" {
            ForEach(section.rows, id: \.self) { key in
                if let entry = inbox.pending(key) {
                    let thread = InboxKey(machineId: key.machineId, id: entry.threadId)
                    Button { actions.open(thread) } label: { InboxUnsentRow(entry: entry, thread: inbox.row(thread)) }
                        .buttonStyle(.row).accessibilityIdentifier("unsent.\(key.id)")
                        .inboxRowChrome()
                }
            }
        } else {
            ForEach(section.rows, id: \.self) { key in
                if let row = inbox.row(key) { threadRow(row, key: key, section: section.key) }
            }
        }
    }

    private func threadRow(_ row: ThreadRow, key: InboxKey, section: String) -> some View {
        let snoozed = section == "snoozed"
        let settled = section == "settled"
        // A view-only grant is per machine: only that machine's rows lose their actions.
        let canOperate = inbox.client(key.machineId)?.canOperate ?? false
        // The daemon refuses to settle a tree that still runs.
        let canSettle = canOperate && !settled && row.state != "working"
        return Button { actions.open(key) } label: {
            if settled { InboxSettledRow(row: row) }
            else { InboxThreadRow(row: row, snoozed: snoozed, machine: inbox.showsMachineNames ? inbox.name(key.machineId) : nil) }
        }
        .buttonStyle(.row)
        .accessibilityIdentifier(inbox.showsMachineNames ? "thread.\(key.machineId).\(row.id)" : "thread.\(row.id)")
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
    /// The task list's row chrome: inset 8pt from the screen edge, 4pt between rows, the page
    /// colour behind, and no rules (DESIGN.md: nothing in the task list is ruled).
    func inboxRowChrome() -> some View {
        self
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xxs, leading: AceTheme.Spacing.sm,
                                      bottom: AceTheme.Spacing.xxs, trailing: AceTheme.Spacing.sm))
            .listRowBackground(AceTheme.Colours.background)
            .listRowSeparator(.hidden)
    }
}
