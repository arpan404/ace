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

/// One tab's flat list: the shared sections merged by rank with no headings, rows separated by
/// inset hairlines, then the Snoozed and Settled shelves. `includes` applies the tab and the
/// filter chips; grouping and wording come from each machine's runtime.
struct InboxList: View {
    @Bindable var inbox: MachineInbox
    let includes: (InboxKey) -> Bool
    let pulls: Bool
    @Binding var shelves: InboxShelves
    let actions: InboxRowActions
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
                    .listRowSeparator(.hidden)
                    .listRowBackground(AceTheme.Colours.background)
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
                    if open { rows(section) }
                }
            }
            if !inbox.merged.more.isEmpty {
                Button("Show older threads") { for id in inbox.merged.more { inbox.client(id)?.loadOlderThreads() } }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("inbox.more")
                    .inboxRowChrome()
                    .listRowSeparator(.hidden)
            }
            if sections.isEmpty { emptyState.listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background) }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .environment(\.defaultMinListRowHeight, 0)
    }

    @ViewBuilder private func rows(_ section: MergedInbox.Section) -> some View {
        if section.key == "unsent" {
            ForEach(section.rows, id: \.self) { key in
                if let entry = inbox.pending(key) {
                    let thread = InboxKey(machineId: key.machineId, id: entry.threadId)
                    Button { actions.open(thread) } label: { InboxUnsentRow(entry: entry, thread: inbox.row(thread)) }
                        .buttonStyle(.plain).accessibilityIdentifier("unsent.\(key.id)")
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
            InboxThreadRow(row: row, snoozed: snoozed, machine: inbox.showsMachineNames ? inbox.name(key.machineId) : nil)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(inbox.showsMachineNames ? "thread.\(key.machineId).\(row.id)" : "thread.\(row.id)")
        .inboxRowChrome()
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if canOperate {
                if settled {
                    Button("Unsettle", systemImage: "arrow.uturn.backward") { actions.unsettle(row, key) }.tint(Color(uiColor: .systemGray2))
                } else if canSettle {
                    Button("Settle", systemImage: "checkmark") { actions.settle(row, key) }.tint(.blue)
                }
                if snoozed {
                    Button("Wake", systemImage: "sun.max") { actions.wake(row, key) }.tint(Color(uiColor: .systemGray2))
                } else if !settled {
                    Button("Snooze", systemImage: "clock") { actions.snooze(key) }.tint(Color(uiColor: .systemGray2))
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if canOperate { Button("Archive", systemImage: "archivebox") { actions.archive(row, key) }.tint(Color(uiColor: .systemGray2)) }
        }
        .contextMenu {
            if canOperate {
                if settled { Button("Unsettle", systemImage: "arrow.uturn.backward") { actions.unsettle(row, key) } }
                else if canSettle { Button("Settle", systemImage: "checkmark") { actions.settle(row, key) } }
                if snoozed { Button("Wake", systemImage: "sun.max") { actions.wake(row, key) } }
                else if !settled {
                    Menu("Snooze", systemImage: "clock") {
                        ForEach(inbox.merged.snooze) { option in Button(option.label) { actions.snoozeUntil(row, key, option.id) } }
                    }
                }
                Button("Archive", systemImage: "archivebox") { actions.archive(row, key) }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !inbox.anyLoaded || !inbox.allReady {
            if inbox.sessions.contains(where: { ["fatal", "offline", "reconnecting"].contains($0.client.connection) }) {
                ContentUnavailableView {
                    Label(inbox.showsMachineNames ? "Can't reach your machines" : "Can't reach your machine", systemImage: "wifi.slash")
                } description: { Text("Your threads appear once it's back.") } actions: {
                    Button("Retry") { for session in inbox.sessions { session.client.retry() } }
                }
            } else {
                ContentUnavailableView { Label { Text("Connecting to your machine…") } icon: { ProgressView() } }
            }
        } else if pulls {
            ContentUnavailableView("No pull requests in review", image: "tab-pulls",
                                   description: Text("Threads with an open pull request show here."))
        } else {
            ContentUnavailableView("Your inbox is clear", systemImage: "tray", description: Text("Tasks from your machines appear here."))
        }
    }
}

extension View {
    /// The inbox's row chrome: 20pt side insets, page colour, and one hairline under each row
    /// inset to the text on both sides.
    func inboxRowChrome() -> some View {
        self
            .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xl, bottom: 0, trailing: AceTheme.Spacing.xl))
            .listRowBackground(AceTheme.Colours.background)
            .listRowSeparator(.hidden, edges: .top)
            .listRowSeparatorTint(AceTheme.Colours.separator)
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            .alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] }
    }
}
