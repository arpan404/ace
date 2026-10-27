import SwiftUI

/// Runs one of a thread's menu ids (`threadMenu`: "unread", "move", "delete"…) for the thread
/// named. The inbox provides it, so a row's menu and the open thread's ⋯ do the same thing.
struct ThreadOrganizer {
    let perform: (InboxKey, String) -> Void
    let snooze: (InboxKey, String) -> Void
    let wake: (InboxKey) -> Void
}

extension EnvironmentValues {
    @Entry var threadOrganizer: ThreadOrganizer?
}

/// One thread's actions as menu sections, in the shared order and words (`threadMenu`): read,
/// pin and move; Snooze or Wake; settle and auto-settle; archive and delete, delete in red.
/// Ids this app has no handler for (rename and fork belong to the thread's own header) are
/// left out.
struct ThreadActionItems: View {
    let key: InboxKey
    let row: ThreadRow
    let labels: [String: String]
    let sections: [String: String]
    let snoozeOptions: [InboxLayout.SnoozeOption]
    let organizer: ThreadOrganizer
    /// Extra rows at the end of the read block: Move up and Move down in a hand-sorted list.
    var extra: AnyView? = nil

    static let handled: Set<String> = [
        "new-on-main", "copy-link", "unread", "read", "pin", "unpin", "move", "settle", "unsettle",
        "auto-settle-off", "auto-settle-on", "archive", "restore", "delete",
    ]

    private var ids: [String] { (row.menu ?? []).filter { Self.handled.contains($0) && labels[$0] != nil } }
    private func block(_ name: String) -> [String] { ids.filter { sections[$0] == name } }
    private var snoozed: Bool { row.group == "snoozed" }
    private var settled: Bool { row.group == "settled" }

    var body: some View {
        Section { ForEach(block("start"), id: \.self, content: item) }
        Section {
            ForEach(block("read"), id: \.self, content: item)
            if let extra { extra }
        }
        Section {
            if snoozed {
                Button("Wake", ace: .sun) { organizer.wake(key) }
            } else if !settled, !snoozeOptions.isEmpty {
                Menu {
                    ForEach(snoozeOptions) { option in Button(option.label) { organizer.snooze(key, option.id) } }
                } label: { Label("Snooze", ace: .bellSimpleZ) }
            }
            ForEach(block("settle"), id: \.self, content: item)
        }
        Section { ForEach(block("leave"), id: \.self, content: item) }
    }

    @ViewBuilder private func item(_ id: String) -> some View {
        let label = labels[id] ?? id
        if id == "delete" {
            Button(role: .destructive) { organizer.perform(key, id) } label: { Label(label, ace: .trash) }
                .accessibilityIdentifier("thread.action.delete")
        } else {
            Button(label, ace: Self.icon(id)) { organizer.perform(key, id) }
                .accessibilityIdentifier("thread.action.\(id)")
        }
    }

    static func icon(_ id: String) -> AceIcon.Name {
        switch id {
        case "new-on-main": .notePencil
        case "copy-link": .link
        case "unread": .envelopeSimple
        case "read": .envelopeSimpleOpen
        case "pin": .pushPin
        case "unpin": .pushPinSlash
        case "move": .folderSimple
        case "settle": .check
        case "unsettle": .arrowUUpLeft
        case "auto-settle-off": .timer
        case "auto-settle-on": .clockCountdown
        case "archive": .archive
        case "restore": .trayArrowUp
        case "delete": .trash
        default: .dotsThree
        }
    }
}
