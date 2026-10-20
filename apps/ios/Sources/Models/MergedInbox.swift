import Foundation

/// A row of the merged inbox: a thread (or a held send) on one paired machine. Two machines may
/// use the same thread id; the machine keeps them apart.
struct InboxKey: Hashable, Sendable { let machineId: String; let id: String }

/// One inbox across every paired machine. Each machine's runtime groups its own threads with the
/// shared rules (`@ace/ui-core/mobile`) and ranks every row; this only orders sections by their
/// shared group order and rows by rank. It never decides a group or a status.
struct MergedInbox: Equatable {
    struct Section: Identifiable, Equatable { let key: String; let label: String; let rows: [InboxKey]; var id: String { key } }
    let sections: [Section]
    /// Machines with older threads beyond their loaded window.
    let more: [String]
    let snooze: [InboxLayout.SnoozeOption]
    static let empty = MergedInbox(sections: [], more: [], snooze: [])

    static func merge(_ parts: [(machineId: String, layout: InboxLayout)]) -> MergedInbox {
        struct Group { var order: Int; var first: Int; var label: String; var rows: [(rank: String, key: InboxKey)] }
        var groups: [String: Group] = [:]
        var seen = 0
        for (machine, part) in parts.enumerated() {
            for (position, section) in part.layout.sections.enumerated() {
                var group = groups[section.key] ?? Group(order: section.order ?? position, first: seen, label: section.label, rows: [])
                seen += 1
                for (index, id) in section.ids.enumerated() {
                    // A runtime without ranks keeps its own order after every ranked row.
                    let rank = section.ranks.flatMap { index < $0.count ? $0[index] : nil }
                        ?? String(format: "\u{FFFF}%06d%08d", machine, index)
                    group.rows.append((rank, InboxKey(machineId: part.machineId, id: id)))
                }
                groups[section.key] = group
            }
        }
        let sections = groups.sorted { ($0.value.order, $0.value.first) < ($1.value.order, $1.value.first) }.map { key, group in
            // UTF-16 code-unit order is JavaScript's `<`, which the shared ranks are built for.
            Section(key: key, label: group.label,
                    rows: group.rows.sorted { $0.rank.utf16.lexicographicallyPrecedes($1.rank.utf16) }.map(\.key))
        }
        return MergedInbox(sections: sections, more: parts.filter { $0.layout.more }.map(\.machineId),
                           snooze: parts.first { !$0.layout.snooze.isEmpty }?.layout.snooze ?? [])
    }
}
