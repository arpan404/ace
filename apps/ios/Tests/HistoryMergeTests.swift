import Foundation
import Testing
@testable import Ace

/// History across machines reads as one list, newest first under the web's week groups, and the
/// places it opens from are offered once a machine is paired.
@Suite struct HistoryMergeTests {
    private func thread(_ id: String, at: Double, group: String = "week", label: String = "This week",
                        project: String = "ace", workspace: String = "ace", listed: Bool = true) -> HistoryAnswer.Thread {
        HistoryAnswer.Thread(id: id, title: id, project: project, workspaceId: workspace, at: at, group: group,
                             label: label, date: "1d", listed: listed)
    }

    @Test func twoMachinesHistoriesMergeNewestFirstUnderOneSetOfWeekGroups() {
        let answers = [
            "studio": HistoryAnswer(threads: [thread("s1", at: 90), thread("s2", at: 10, group: "earlier", label: "Earlier")]),
            "laptop": HistoryAnswer(threads: [thread("l1", at: 95), thread("l2", at: 50, group: "last-week", label: "Last week")]),
        ]
        let sections = HistoryMerge.sections(answers)
        #expect(sections.map(\.label) == ["This week", "Last week", "Earlier"])
        #expect(sections.map { $0.rows.map(\.id) } == [["laptop/l1", "studio/s1"], ["laptop/l2"], ["studio/s2"]])
    }

    @Test func theSameThreadIdOnTwoMachinesIsTwoRowsButOneMachinesDuplicateIsOne() {
        let answers = [
            "studio": HistoryAnswer(threads: [thread("a", at: 5), thread("a", at: 5)]),
            "laptop": HistoryAnswer(threads: [thread("a", at: 5)]),
        ]
        #expect(HistoryMerge.sections(answers).flatMap(\.rows).map(\.id) == ["laptop/a", "studio/a"])
    }

    @Test func aProjectFilterKeepsOnlyThatMachinesProject() {
        let answers = [
            "studio": HistoryAnswer(threads: [thread("ace-studio", at: 3), thread("notes", at: 2, project: "notes", workspace: "notes")]),
            "laptop": HistoryAnswer(threads: [thread("ace-laptop", at: 4)]),
        ]
        #expect(HistoryMerge.sections(answers, project: "studio/ace").flatMap(\.rows).map(\.thread.id) == ["ace-studio"])
        #expect(HistoryMerge.sections(answers, project: "gone/ace").isEmpty)
    }

    @Test func projectChoicesAreNamedByMachineWhenThereAreSeveral() {
        let answers = [
            "studio": HistoryAnswer(threads: [thread("a", at: 3), thread("b", at: 2, project: "notes", workspace: "notes"),
                                              thread("hit", at: 1, project: "", workspace: "elsewhere", listed: false)]),
            "laptop": HistoryAnswer(threads: [thread("c", at: 4)]),
        ]
        #expect(HistoryMerge.projects(answers).map(\.name) == ["ace", "ace", "notes"])
        let named = HistoryMerge.projects(answers) { $0 == "studio" ? "Studio" : "Laptop" }
        #expect(named.map(\.name) == ["Laptop · ace", "Studio · ace", "Studio · notes"])
        #expect(named.map(\.id) == ["laptop/ace", "studio/ace", "studio/notes"])
    }

    @Test func historyArchivedUsageAndAutomationsAreOfferedOnceAMachineIsPaired() {
        #expect(SearchPlace.offered(paired: false) == [.machines, .settings])
        let paired = SearchPlace.offered(paired: true)
        for place in [SearchPlace.usage, .automations, .history, .archived] { #expect(paired.contains(place)) }
    }
}
