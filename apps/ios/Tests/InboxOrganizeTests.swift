import Foundation
import Testing
@testable import Ace

/// The parts of organizing threads across machines that the phone does itself: sending each
/// machine its own picks, putting several machines' delete questions together, and keeping
/// recent searches.
@Suite @MainActor struct InboxOrganizeTests {
    @Test func eachMachineGetsItsOwnPicksInTheOrderTheyWereListed() {
        let keys = [InboxKey(machineId: "studio", id: "a"), InboxKey(machineId: "mac", id: "b"),
                    InboxKey(machineId: "studio", id: "c")]
        let groups = InboxOrganize.byMachine(keys)
        #expect(groups.map(\.machineId) == ["studio", "mac"])
        #expect(groups.map(\.ids) == [["a", "c"], ["b"]])
    }

    @Test func deletingAcrossMachinesStopsRunningWorkWhenAnyMachineHasSome() {
        let calm = DeleteQuestion(title: "Delete thread?", message: "", running: "", confirm: "Delete", force: false)
        let busy = DeleteQuestion(title: "Delete thread?", message: "", running: "1 agent running.", confirm: "Stop and delete", force: true)
        let both = InboxOrganize.combined([calm, busy], count: 2)
        #expect(both.title == "Delete 2 threads?")
        #expect(both.confirm == "Stop and delete")
        #expect(both.force)
        #expect(!InboxOrganize.combined([calm, calm], count: 2).force)
    }

    @Test func recentSearchesKeepTheNewestEightWithoutRepeats() {
        var list: [String] = []
        for index in 0..<10 { list = RecentSearches.adding("query \(index)", to: list) }
        list = RecentSearches.adding("  query 5 ", to: list)
        #expect(list.count == RecentSearches.keep)
        #expect(list.first == "query 5")
        #expect(list.filter { $0 == "query 5" }.count == 1)
        #expect(RecentSearches.adding("   ", to: list) == list)
    }

    @Test func aLinkToSettingsOpensThePageThePhoneHas() {
        #expect(SettingsRoute.linked("machines") == [.machines])
        #expect(SettingsRoute.linked("appearance") == [.appearance])
        #expect(SettingsRoute.linked("something-else") == [])
    }

    @Test func copyLinkNamesTheThreadAndItsMachine() {
        #expect(AceLink.thread("t-1", machine: "studio").absoluteString == "ace://thread/t-1?machine=studio")
        #expect(AceLink.thread("t-1", machine: nil).absoluteString == "ace://thread/t-1")
    }
}
