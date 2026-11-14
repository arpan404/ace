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

/// History reads again when a thread joins or leaves Settled or a settled row changes, and never
/// for the rest of the list's traffic.
@Suite struct HistoryRevisionTests {
    private func row(_ id: String, title: String? = nil, state: String = "done") -> ThreadRow {
        ThreadRow(id: id, title: title ?? id, state: state, attention: nil, project: "ace", branch: "", machine: "", provider: "codex",
                  model: "", agents: 1, snoozedUntil: nil, updatedAt: 1, canSteer: false,
                  status: StatusDisplay(label: "Done", token: "done"), machineId: nil, activityAt: nil)
    }
    private func layout(inbox: [String], settled: [String]) -> InboxLayout {
        InboxLayout(sections: [InboxLayout.Section(key: "inbox", label: "Inbox", ids: inbox, tab: "inbox"),
                               InboxLayout.Section(key: "settled", label: "Settled", ids: settled, tab: "settled")],
                    more: false, snooze: [])
    }

    @Test func settlingAndReopeningAThreadReadsHistoryAgain() {
        var revision = HistoryRevision()
        revision.layout(layout(inbox: ["a", "b"], settled: []))
        let start = revision.value
        revision.layout(layout(inbox: ["b"], settled: ["a"]))
        #expect(revision.value != start)
        let settled = revision.value
        revision.layout(layout(inbox: ["a", "b"], settled: []))
        #expect(revision.value != settled)
    }

    @Test func renamingOrUpdatingASettledThreadReadsHistoryAgain() {
        var revision = HistoryRevision()
        revision.layout(layout(inbox: [], settled: ["a"]))
        let start = revision.value
        revision.row("a", old: row("a"), new: row("a", title: "Renamed"))
        #expect(revision.value != start)
    }

    @Test func aWorkingThreadsStreamAndAnUnchangedLayoutDontReadHistoryAgain() {
        var revision = HistoryRevision()
        revision.layout(layout(inbox: ["live"], settled: ["a"]))
        let start = revision.value
        revision.row("live", old: row("live", state: "working"), new: row("live", title: "Streaming", state: "working"))
        revision.row("a", old: row("a"), new: row("a"))
        revision.layout(layout(inbox: ["live"], settled: ["a"]))
        #expect(revision.value == start)
    }
}

/// What History says when machines can't answer, and how answers from several machines combine.
@Suite struct HistoryAnswerTests {
    private let one = HistoryAnswer(threads: [HistoryAnswer.Thread(id: "a", title: "A", project: "ace", workspaceId: "ace", at: 1,
                                                                   group: "week", label: "This week", date: "1d", listed: true)])

    @Test func machinesStillMakingTheirFirstConnectionShowLoadingAndOfflineOnesAFailure() {
        #expect(HistoryList.phaseWithoutAnswers(["connecting"]) == .loading)
        #expect(HistoryList.phaseWithoutAnswers(["reconnecting", "starting"]) == .loading)
        #expect(HistoryList.phaseWithoutAnswers(["reconnecting"]) == .failed)
        #expect(HistoryList.phaseWithoutAnswers(["fatal", "offline"]) == .failed)
        #expect(HistoryList.phaseWithoutAnswers([]) == .failed)
    }

    @Test func everyMachineFailingToAnswerIsAFailure() {
        let result = HistoryList.merged(found: [:], paired: ["studio", "laptop"], previous: [:], sameQuery: false)
        #expect(result.phase == .failed)
        #expect(result.answers.isEmpty)
    }

    @Test func oneMachineFailingKeepsItsLastAnswerToTheSameQueryOnly() {
        let kept = HistoryList.merged(found: ["laptop": one], paired: ["studio", "laptop"], previous: ["studio": one], sameQuery: true)
        #expect(kept.phase == .ready)
        #expect(Set(kept.answers.keys) == ["studio", "laptop"])
        let changed = HistoryList.merged(found: ["laptop": one], paired: ["studio", "laptop"], previous: ["studio": one], sameQuery: false)
        #expect(Set(changed.answers.keys) == ["laptop"])
    }

    @Test func aGroupMetTwiceStillShowsAsOneSection() {
        func thread(_ id: String, at: Double, group: String, label: String) -> HistoryAnswer.Thread {
            HistoryAnswer.Thread(id: id, title: id, project: "ace", workspaceId: "ace", at: at, group: group, label: label, date: "", listed: true)
        }
        // An answer kept from an earlier read filed its thread a week later than the rest.
        let answers = [
            "studio": HistoryAnswer(threads: [thread("s1", at: 90, group: "week", label: "This week"),
                                              thread("s2", at: 70, group: "week", label: "This week")]),
            "laptop": HistoryAnswer(threads: [thread("l1", at: 80, group: "last-week", label: "Last week")]),
        ]
        let sections = HistoryMerge.sections(answers)
        #expect(sections.map(\.id) == ["week", "last-week"])
        #expect(Set(sections.map(\.id)).count == sections.count)
        #expect(sections[0].rows.map(\.id) == ["studio/s1", "studio/s2"])
    }
}
