import Foundation

/// The Spade list's pins, as web's list top shows them (`spade-pin-strip.tsx`): pinned bots and
/// groups leave the rows for the strip above them, oldest pin first. Spade itself is never
/// pinned: it is always the list's first row. Pure.
enum SpadePins {
    /// The strip's entries, oldest pin first, and the rows that stay in the list, in its order.
    static func split(_ entries: [SpadeRoster.Entry]) -> (strip: [SpadeRoster.Entry], rows: [SpadeRoster.Entry]) {
        var strip: [(entry: SpadeRoster.Entry, offset: Int)] = []
        var rows: [SpadeRoster.Entry] = []
        for (offset, entry) in entries.enumerated() {
            if pinnable(entry.bot), entry.bot.pinned { strip.append((entry, offset)) } else { rows.append(entry) }
        }
        let ordered = strip.sorted { a, b in
            let (x, y) = (a.entry.bot.pinnedAt ?? 0, b.entry.bot.pinnedAt ?? 0)
            // Pinned at the same moment: the list's own order.
            return x != y ? x < y : a.offset < b.offset
        }
        return (ordered.map(\.entry), rows)
    }

    /// Whether a row offers Pin or Unpin: every bot and group but Spade itself.
    static func pinnable(_ bot: SpadeModel.Bot) -> Bool { !bot.main }
}
