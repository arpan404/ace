import Foundation
import Testing
@testable import Ace

/// The Agents page's tree: indents, folds, and what never folds away.
@Suite @MainActor struct AgentTreeLayoutTests {
    private func row(_ id: String, parent: String?, depth: Int, running: Bool = false, needsYou: Bool = false, failed: Bool = false) -> AgentSheet.Row {
        let token = failed ? "failed" : needsYou ? "needsYou" : running ? "working" : "done"
        return AgentSheet.Row(id: id, parentId: parent, depth: depth, name: id, model: "", status: StatusDisplay(label: token, token: token),
                              activity: "", running: running || needsYou, needsYou: needsYou, tokens: nil, costUsd: nil,
                              childThreadId: nil, descendants: 0, stoppable: running, background: false, createdAt: 0, endedAt: nil,
                              icon: AgentSheet.Icon(kind: failed ? "failed" : running ? "working" : "done", tone: "", count: nil))
    }
    private func task(_ id: String, agent: String, running: Bool) -> AgentSheet.BackgroundTask {
        AgentSheet.BackgroundTask(id: id, agentId: agent, kind: "shell", title: id,
                                  status: StatusDisplay(label: running ? "running" : "finished", token: running ? "working" : "done"),
                                  stoppable: running, startedAt: 0, endedAt: nil)
    }
    private func ids(_ lines: [AgentTreeLine]) -> [String] { lines.map(\.id) }

    @Test func childrenIndentUnderTheirParentAndCommandsFollowSubagents() {
        let lines = AgentTreeLayout.lines(rows: [row("root", parent: nil, depth: 0, running: true), row("a", parent: "root", depth: 1, running: true)],
                                          tasks: [task("watch", agent: "root", running: true)], expanded: [])
        #expect(ids(lines) == ["agent:root", "agent:a", "task:watch"])
        #expect(lines.map(\.level) == [0, 1, 1])
    }

    @Test func aBranchBelowTwoLevelsFoldsUntilOpened() {
        let rows = [row("root", parent: nil, depth: 0, running: true), row("a", parent: "root", depth: 1, running: true),
                    row("b", parent: "a", depth: 2, running: true), row("c", parent: "b", depth: 3, running: true),
                    row("d", parent: "c", depth: 4, running: true)]
        let folded = AgentTreeLayout.lines(rows: rows, tasks: [], expanded: [])
        #expect(ids(folded) == ["agent:root", "agent:a", "agent:b", "more:b"])
        if case .more(_, let count, let finished, let level) = folded.last { #expect(count == 2 && !finished && level == 3) }
        let opened = AgentTreeLayout.lines(rows: rows, tasks: [], expanded: ["b"])
        #expect(ids(opened) == ["agent:root", "agent:a", "agent:b", "agent:c", "agent:d"])
    }

    @Test func aDeepAgentThatNeedsThePersonIsNeverFolded() {
        let rows = [row("root", parent: nil, depth: 0, needsYou: true), row("a", parent: "root", depth: 1, needsYou: true),
                    row("b", parent: "a", depth: 2, needsYou: true), row("asker", parent: "b", depth: 3, needsYou: true)]
        #expect(ids(AgentTreeLayout.lines(rows: rows, tasks: [], expanded: [])).contains("agent:asker"))
    }

    @Test func manyFinishedSiblingsFoldButWorkingAndFailedOnesStay() {
        var rows = [row("root", parent: nil, depth: 0, running: true), row("live", parent: "root", depth: 1, running: true),
                    row("broken", parent: "root", depth: 1, failed: true)]
        for index in 0..<10 { rows.append(row("done\(index)", parent: "root", depth: 1)) }
        let lines = AgentTreeLayout.lines(rows: rows, tasks: [], expanded: [])
        let shown = ids(lines)
        #expect(shown.contains("agent:live") && shown.contains("agent:broken"))
        #expect(shown.filter { $0.hasPrefix("agent:done") }.count == AgentTreeLayout.shownFinished)
        if case .more(let key, let count, let finished, _) = lines.last {
            #expect(finished && count == 10 - AgentTreeLayout.shownFinished && key == AgentTreeLayout.finishedKey("root"))
        } else { Issue.record("no fold for the finished agents") }
        let opened = AgentTreeLayout.lines(rows: rows, tasks: [], expanded: [AgentTreeLayout.finishedKey("root")])
        #expect(ids(opened).filter { $0.hasPrefix("agent:done") }.count == 10)
    }

    @Test func endedCommandsFoldWhileRunningOnesStay() {
        var tasks = [task("live", agent: "root", running: true)]
        for index in 0..<8 { tasks.append(task("ended\(index)", agent: "root", running: false)) }
        let lines = AgentTreeLayout.lines(rows: [row("root", parent: nil, depth: 0, running: true)], tasks: tasks, expanded: [])
        #expect(ids(lines).contains("task:live"))
        #expect(ids(lines).filter { $0.hasPrefix("task:ended") }.count == AgentTreeLayout.shownFinished)
        #expect(ids(lines).last == "more:\(AgentTreeLayout.commandsKey("root"))")
    }
}

/// Which pages a thread gets on a phone.
@Suite struct ThreadPagesTests {
    @Test func aPageShowsOnlyWhenTheThreadHasSomethingForIt() {
        let bare = ThreadPages(ThreadPageFacts())
        #expect(bare.kinds == [.chat, .files, .terminal])
        let busy = ThreadPages(ThreadPageFacts(changedFiles: 6, hasBrowser: true, agents: 3))
        #expect(busy.kinds == [.chat, .changes, .files, .terminal, .browser, .agents])
        #expect(busy.count(of: .changes) == 6)
    }

    @Test func aChatHasNoCheckoutPages() {
        #expect(ThreadPages(ThreadPageFacts(chat: true, changedFiles: 3, agents: 2)).kinds == [.chat, .agents])
    }

    @Test func aPageAskedForStaysWhileItOpensAndAGonePageFallsBackToChat() {
        let opening = ThreadPages(ThreadPageFacts(requested: .browser))
        #expect(opening.shown(.browser) == .browser)
        let closed = ThreadPages(ThreadPageFacts())
        #expect(closed.shown(.browser) == .chat)
        #expect(closed.neighbour(of: .chat, step: 1) == .files)
        #expect(closed.neighbour(of: .chat, step: -1) == nil)
    }
}
