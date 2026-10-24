import Testing
@testable import Ace

/// Sections from separate machine runtimes merge by their shared ranks (`inboxRank`).
@Suite struct MergedInboxTests {
    @Test func rowsFromTwoMachinesInterleaveByRankAndKeepTheSameThreadIdApart() {
        let merged = MergedInbox.merge([
            ("studio", layout([section("working", order: 1, ["t1": "0002", "t2": "0004"]), section("done", order: 4, ["t9": "0001"])])),
            ("laptop", layout([section("needs-you", order: 0, ["a": "0005"]), section("working", order: 1, ["t1": "0003"])], more: true)),
        ])
        #expect(merged.sections.map(\.key) == ["needs-you", "working", "done"])
        #expect(merged.sections[1].rows == [key("studio", "t1"), key("laptop", "t1"), key("studio", "t2")])
        #expect(merged.more == ["laptop"])
        #expect(merged.snooze.map(\.id) == ["hour"])
    }

    @Test func ranksCompareAsJavaScriptDoesNotByUnicodeCollation() {
        // "é" (U+00E9) sorts after "z" in UTF-16 code units; Swift's collation would put it first.
        let merged = MergedInbox.merge([
            ("a", layout([section("done", order: 4, ["x": "0001\u{0}a\u{0}é"])])),
            ("b", layout([section("done", order: 4, ["y": "0001\u{0}a\u{0}z"])])),
        ])
        #expect(merged.sections[0].rows == [key("b", "y"), key("a", "x")])
    }

    @Test func aMachineThatHasNotRankedItsRowsKeepsItsOrderAfterRankedOnes() {
        let unranked = InboxLayout.Section(key: "done", label: "Done", ids: ["b", "a"])
        let merged = MergedInbox.merge([
            ("old", InboxLayout(sections: [unranked], more: false, snooze: [])),
            ("new", layout([section("done", order: 4, ["c": "0009"])])),
        ])
        #expect(merged.sections[0].rows == [key("new", "c"), key("old", "b"), key("old", "a")])
    }

    @Test func settledCountsEachMachinesUnloadedThreadsOnlyWhileTheScopeTakesThatWholeMachine() {
        var studio = section("settled", order: 6, ["s1": "0001", "s2": "0002"]); studio.total = 30
        var laptop = section("settled", order: 6, ["l1": "0003"]); laptop.total = 5
        let merged = MergedInbox.merge([("studio", layout([studio], more: true)), ("laptop", layout([laptop], more: true))])
        let everything = merged.sections[0].scoped({ _ in true }, whole: { _ in true })
        #expect(everything?.count == 35)
        // The studio tab: the laptop's rows and its unloaded threads both leave the count.
        let studioTab = merged.sections[0].scoped({ $0.machineId == "studio" }, whole: { $0 == "studio" })
        #expect(studioTab?.rows == [key("studio", "s1"), key("studio", "s2")])
        #expect(studioTab?.count == 30)
        // A project chip counts only the loaded rows it can read a project from.
        let project = merged.sections[0].scoped({ $0.id == "s1" }, whole: { _ in false })
        #expect(project?.count == 1)
        #expect(merged.sections[0].scoped({ _ in false }, whole: { _ in false }) == nil)
    }

    private func key(_ machine: String, _ id: String) -> InboxKey { InboxKey(machineId: machine, id: id) }
    private func section(_ key: String, order: Int, _ rows: KeyValuePairs<String, String>) -> InboxLayout.Section {
        InboxLayout.Section(key: key, label: key, ids: rows.map(\.key), ranks: rows.map(\.value), order: order)
    }
    private func layout(_ sections: [InboxLayout.Section], more: Bool = false) -> InboxLayout {
        InboxLayout(sections: sections, more: more, snooze: [.init(id: "hour", label: "In an hour")])
    }
}
