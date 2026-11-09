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

/// Which pages a thread gets on a phone, and where its other screens open.
@Suite struct ThreadPagesTests {
    @Test func changesJoinsChatOnlyWhenTheThreadHasChanges() {
        #expect(ThreadPages(ThreadPageFacts()).kinds == [.chat])
        let changed = ThreadPages(ThreadPageFacts(changedFiles: 6))
        #expect(changed.kinds == [.chat, .changes])
        #expect(changed.label(of: .changes) == "Changes, 6 files")
        #expect(ThreadPages(ThreadPageFacts(changedFiles: 1)).label(of: .changes) == "Changes, 1 file")
        #expect(changed.label(of: .chat) == "Chat")
    }

    @Test func aChatHasNoChangesPageAndNoCheckoutScreens() {
        let chat = ThreadPages(ThreadPageFacts(chat: true, changedFiles: 3))
        #expect(chat.kinds == [.chat])
        #expect(!chat.checkout)
        #expect(ThreadPages(ThreadPageFacts()).checkout)
    }

    @Test func changesAskedForStaysWhileItShowsAndFallsBackToChatOnceGone() {
        let asked = ThreadPages(ThreadPageFacts(requested: .changes))
        #expect(asked.shown(.changes) == .changes)
        #expect(ThreadPages(ThreadPageFacts()).shown(.changes) == .chat)
    }

    @Test func filesTerminalBrowserAndAgentsPushInsteadOfBeingPages() {
        for destination in [ThreadDestination.files, .terminal, .browser, .agents] {
            #expect(destination.page == nil)
            #expect(destination.pushed != nil)
        }
        #expect(ThreadDestination.changes.page == .changes)
        #expect(ThreadDestination.changes.pushed == nil)
        #expect(ThreadDestination.logs.pushed == nil)
    }
}
