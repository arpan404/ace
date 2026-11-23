import Testing
@testable import Ace

/// The Spade list's pins: pinned bots and groups show in the strip, oldest pin first, and leave
/// the rows; Spade itself never pins.
@Suite struct SpadePinsTests {
    @Test func pinnedRowsLeaveTheListForTheStripOldestPinFirst() {
        let split = SpadePins.split([
            entry("spade", main: true),
            entry("notes", pinnedAt: 30),
            entry("plan"),
            entry("launch", group: "launch", pinnedAt: 10),
            entry("travel", pinnedAt: 20),
        ])
        #expect(split.strip.map(\.bot.id) == ["launch", "travel", "notes"])
        #expect(split.rows.map(\.bot.id) == ["spade", "plan"])
    }

    @Test func pinsMadeAtTheSameMomentKeepTheListsOrder() {
        let split = SpadePins.split([entry("b", pinnedAt: 5), entry("a", pinnedAt: 5)])
        #expect(split.strip.map(\.bot.id) == ["b", "a"])
    }

    @Test func spadeItselfStaysTheFirstRowEvenWhenSpadeSaysItIsPinned() {
        let split = SpadePins.split([entry("spade", main: true, pinnedAt: 1), entry("notes")])
        #expect(split.strip.isEmpty)
        #expect(split.rows.map(\.bot.id) == ["spade", "notes"])
        #expect(!SpadePins.pinnable(entry("spade", main: true).bot))
        #expect(SpadePins.pinnable(entry("launch", group: "launch").bot))
    }

    private func entry(_ id: String, main: Bool = false, group: String? = nil, pinnedAt: Double? = nil) -> SpadeRoster.Entry {
        let bot = SpadeModel.Bot(id: id, conversation: "c-\(id)", name: id, main: main, initial: "X", group: group,
                                 faces: [], state: "rest", line: "", pinned: pinnedAt != nil, pinnedAt: pinnedAt)
        return SpadeRoster.Entry(machine: "laptop", machineName: "Laptop", bot: bot)
    }
}
