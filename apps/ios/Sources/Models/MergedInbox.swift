import Foundation

/// A row of the merged inbox: a thread (or a held send) on one paired machine. Two machines may
/// use the same thread id; the machine keeps them apart.
struct InboxKey: Hashable, Sendable { let machineId: String; let id: String }

/// One inbox across every paired machine. Each machine's runtime groups its own threads with the
/// shared rules (`@ace/ui-core/mobile`) and ranks every row; this only orders sections by their
/// shared group order and rows by rank. It never decides a group or a status.
struct MergedInbox: Equatable {
    struct Section: Identifiable, Equatable {
        let key: String; let label: String; let rows: [InboxKey]
        /// The Threads tab that lists it, as its machines' runtimes say.
        var tab = "inbox"
        /// Per machine, the threads its runtime counts in this section but hasn't loaded yet
        /// (older settled pages the daemon holds back).
        var unloaded: [String: Int] = [:]
        var id: String { key }

        /// The section narrowed to `includes`. `whole` says whether the scope takes every thread
        /// of a machine; only then do that machine's unloaded threads still count.
        func scoped(_ includes: (InboxKey) -> Bool, whole: (String) -> Bool) -> Section? {
            let kept = rows.filter(includes)
            let counted = unloaded.filter { whole($0.key) }
            if kept.isEmpty && counted.isEmpty { return nil }
            return Section(key: key, label: label, rows: kept, tab: tab, unloaded: counted)
        }

        /// What the section's heading shows: its rows plus every thread it counts but hasn't loaded.
        var count: Int { rows.count + unloaded.values.reduce(0, +) }
    }
    /// One Threads tab across every machine: the first machine's words, and how many threads
    /// need the person by every machine's daemon (its rail dot).
    struct Tab: Identifiable, Equatable {
        let id: String; let label: String; var counted = false; let empty: String; let emptyLine: String?
        var needsYou = 0
        /// What compose starts while this tab shows: "thread", or "chat" on Chats.
        var compose = "thread"
        /// Chats lists the chats layout, not the inbox's sections.
        var chats: Bool { compose == "chat" }
    }
    let sections: [Section]
    /// Inbox, Snoozed and Settled, in the runtimes' order; empty until a machine sends them.
    var tabs: [Tab] = []
    /// Machines with older threads beyond their loaded window.
    let more: [String]
    let snooze: [InboxLayout.SnoozeOption]
    /// The words for rows' `menu` ids, from the first machine that sends them.
    var menuLabels: [String: String] = [:]
    /// The block ("start", "read", "settle", "leave") each menu id belongs to.
    var menuSections: [String: String] = [:]
    static let empty = MergedInbox(sections: [], more: [], snooze: [])

    static func merge(_ parts: [(machineId: String, layout: InboxLayout)]) -> MergedInbox {
        struct Group { var order: Int; var first: Int; var label: String; var tab: String?; var rows: [(rank: String, key: InboxKey)]; var unloaded: [String: Int] = [:] }
        var groups: [String: Group] = [:]
        var seen = 0
        for (machine, part) in parts.enumerated() {
            // The tab each section is in is the daemon's: whichever of its placed lists holds it.
            let placed = part.layout.tabs
            let snoozed = Set(placed?.snoozed ?? []), settled = Set(placed?.settled ?? [])
            // Nil while the section can't say: no tab named and no loaded row to read it from.
            func tab(of section: InboxLayout.Section) -> String? {
                if let tab = section.tab { return tab }
                guard let first = section.ids.first else { return nil }
                return snoozed.contains(first) ? "snoozed" : settled.contains(first) ? "settled" : "inbox"
            }
            for (position, section) in part.layout.sections.enumerated() {
                var group = groups[section.key] ?? Group(order: section.order ?? position, first: seen, label: section.label,
                                                           tab: nil, rows: [])
                // The first machine that can say places the group, so one machine's empty section
                // never pulls another machine's rows into the wrong tab.
                if group.tab == nil { group.tab = tab(of: section) }
                seen += 1
                for (index, id) in section.ids.enumerated() {
                    // A runtime without ranks keeps its own order after every ranked row.
                    let rank = section.ranks.flatMap { index < $0.count ? $0[index] : nil }
                        ?? String(format: "\u{FFFF}%06d%08d", machine, index)
                    group.rows.append((rank, InboxKey(machineId: part.machineId, id: id)))
                }
                if let total = section.total, total > section.ids.count {
                    group.unloaded[part.machineId, default: 0] += total - section.ids.count
                }
                groups[section.key] = group
            }
        }
        let sections = groups.sorted { ($0.value.order, $0.value.first) < ($1.value.order, $1.value.first) }.map { key, group in
            // UTF-16 code-unit order is JavaScript's `<`, which the shared ranks are built for.
            Section(key: key, label: group.label,
                    rows: group.rows.sorted { $0.rank.utf16.lexicographicallyPrecedes($1.rank.utf16) }.map(\.key),
                    tab: group.tab ?? "inbox", unloaded: group.unloaded)
        }
        // The words from the first machine that sends them; the Inbox's dot from every daemon's.
        let needsYou = parts.reduce(0) { $0 + ($1.layout.attention?.threads.needsYou ?? 0) }
        let chatsNeedYou = parts.reduce(0) { $0 + ($1.layout.attention?.chats.needsYou ?? 0) }
        let tabs: [Tab] = (parts.lazy.compactMap(\.layout.tabWords).first ?? []).map { words in
            let compose = words.compose ?? "thread"
            return Tab(id: words.id, label: words.label, counted: words.counted ?? false, empty: words.empty,
                       emptyLine: words.emptyLine,
                       needsYou: words.id == "inbox" ? needsYou : compose == "chat" ? chatsNeedYou : 0, compose: compose)
        }
        return MergedInbox(sections: sections, tabs: tabs, more: parts.filter { $0.layout.more }.map(\.machineId),
                           snooze: parts.first { !$0.layout.snooze.isEmpty }?.layout.snooze ?? [],
                           menuLabels: parts.lazy.compactMap(\.layout.menuLabels).first ?? [:],
                           menuSections: parts.lazy.compactMap(\.layout.menuSections).first ?? [:])
    }
}
