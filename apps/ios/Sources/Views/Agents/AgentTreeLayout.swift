import Foundation

/// One line of the Agents page's tree, at its indent level (the main agent is level 0).
enum AgentTreeLine: Identifiable, Equatable {
    case agent(AgentSheet.Row, level: Int)
    /// A background command, a quiet node under the agent that started it.
    case task(AgentSheet.BackgroundTask, level: Int)
    /// What a fold holds: a branch below two levels ("Show 12 more"), or a long run of finished
    /// siblings ("Show 157 finished"). `key` is what opening it adds to the expanded set.
    case more(key: String, count: Int, finished: Bool, level: Int)

    var id: String {
        switch self {
        case .agent(let row, _): "agent:\(row.id)"
        case .task(let task, _): "task:\(task.id)"
        case .more(let key, _, _, _): "more:\(key)"
        }
    }
    var level: Int {
        switch self {
        case .agent(_, let level), .task(_, let level), .more(_, _, _, let level): level
        }
    }
}

/// Lays the bridge's agent rows and background tasks out as an indented tree. The rows come
/// depth-first with their parents; this only places them. Each agent's commands follow its
/// subagents. Below two levels a branch folds into one "Show N more" line until the person opens
/// it, except a branch where something needs the person, which always shows. Past a few finished
/// siblings the rest fold into "Show N finished", so what still works stays in view; a failure
/// never folds.
enum AgentTreeLayout {
    /// Levels shown before a branch folds.
    static let shownLevels = 2
    /// Finished siblings shown before the rest fold.
    static let shownFinished = 3

    /// The fold key for a node's finished children.
    static func finishedKey(_ parent: String) -> String { "\(parent)#finished" }
    /// The fold key for a node's ended background commands.
    static func commandsKey(_ parent: String) -> String { "\(parent)#commands" }
    /// Settled for good and not a failure: safe to fold away.
    private static func finished(_ row: AgentSheet.Row) -> Bool {
        !row.running && !row.needsYou && row.status.token != "failed" && row.icon?.kind != "failed"
    }

    static func lines(rows: [AgentSheet.Row], tasks: [AgentSheet.BackgroundTask], expanded: Set<String>) -> [AgentTreeLine] {
        let ids = Set(rows.map(\.id))
        var children: [String: [AgentSheet.Row]] = [:]
        var roots: [AgentSheet.Row] = []
        for row in rows {
            if let parent = row.parentId, ids.contains(parent) { children[parent, default: []].append(row) } else { roots.append(row) }
        }
        var commands: [String: [AgentSheet.BackgroundTask]] = [:]
        var loose: [AgentSheet.BackgroundTask] = []
        for task in tasks {
            if ids.contains(task.agentId) { commands[task.agentId, default: []].append(task) } else { loose.append(task) }
        }

        var below: [String: Int] = [:]
        var asking: [String: Bool] = [:]
        // What each branch holds, and whether anything in it needs the person, from the leaves up.
        for row in rows.reversed() {
            let kids = children[row.id] ?? []
            below[row.id] = kids.reduce(commands[row.id]?.count ?? 0) { $0 + 1 + (below[$1.id] ?? 0) }
            asking[row.id] = kids.contains { $0.needsYou || asking[$0.id] == true }
        }

        var lines: [AgentTreeLine] = []
        lines.reserveCapacity(rows.count + tasks.count)
        /// `opened`: an ancestor was opened, so its whole branch shows.
        func place(_ row: AgentSheet.Row, level: Int, opened: Bool = false) {
            lines.append(.agent(row, level: level))
            let held = below[row.id] ?? 0
            let opens = opened || expanded.contains(row.id)
            if level >= shownLevels, held > 0, !opens, asking[row.id] != true {
                lines.append(.more(key: row.id, count: held, finished: false, level: level + 1))
                return
            }
            let kids = children[row.id] ?? []
            let done = kids.filter(finished)
            let foldsDone = done.count > shownFinished + 1 && !expanded.contains(finishedKey(row.id))
            var doneShown = 0
            for child in kids {
                if foldsDone, finished(child) {
                    doneShown += 1
                    if doneShown > shownFinished { continue }
                }
                place(child, level: level + 1, opened: opens)
            }
            if foldsDone {
                lines.append(.more(key: finishedKey(row.id), count: done.count - shownFinished, finished: true, level: level + 1))
            }
            let cmds = commands[row.id] ?? []
            let ended = cmds.filter { $0.status.token == "done" || $0.status.token == "neutral" }
            let foldsEnded = ended.count > shownFinished + 1 && !expanded.contains(commandsKey(row.id))
            var endedShown = 0
            for task in cmds {
                if foldsEnded, task.status.token == "done" || task.status.token == "neutral" {
                    endedShown += 1
                    if endedShown > shownFinished { continue }
                }
                lines.append(.task(task, level: level + 1))
            }
            if foldsEnded {
                lines.append(.more(key: commandsKey(row.id), count: ended.count - shownFinished, finished: true, level: level + 1))
            }
        }
        for root in roots { place(root, level: 0) }
        // Commands whose agent isn't on this page yet sit under the main agent.
        for task in loose { lines.append(.task(task, level: roots.isEmpty ? 0 : 1)) }
        return lines
    }
}
