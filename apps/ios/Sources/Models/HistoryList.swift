import Foundation
import Observation

/// One machine's History (`HistoryAnswer` in `bridge/history.ts`): its settled threads, newest
/// first, each with the web's week group and date words.
struct HistoryAnswer: Decodable, Sendable, Equatable {
    struct Thread: Decodable, Sendable, Equatable {
        let id: String
        let title: String
        /// The project's name; empty when the machine doesn't list it.
        let project: String
        let workspaceId: String
        let at: Double
        let group: String
        let label: String
        let date: String
        /// On the machine's list now; otherwise found by its search (older, not loaded).
        let listed: Bool
    }
    let threads: [Thread]
}

/// A settled thread on one machine. Two machines can hold the same id, so the machine tells it apart.
struct HistoryRow: Identifiable, Equatable {
    let machineId: String
    let thread: HistoryAnswer.Thread
    var id: String { "\(machineId)/\(thread.id)" }
    var key: InboxKey { InboxKey(machineId: machineId, id: thread.id) }
    /// The project filter's id for its project: "machine/workspace".
    var project: String { "\(machineId)/\(thread.workspaceId)" }
}

/// One week group of History: "This week", "Last week" or "Earlier".
struct HistorySection: Identifiable, Equatable {
    let group: String
    let label: String
    var rows: [HistoryRow]
    var id: String { group }
}

/// A project History can be narrowed to.
struct HistoryProject: Identifiable, Equatable {
    /// "machine/workspace".
    let id: String
    let name: String
}

/// Every machine's History as one list: newest first, each thread once, grouped by week as the
/// web's `historySections` does. Pure, so the rules are tested without a machine.
enum HistoryMerge {
    /// `project` is "machine/workspace", or empty for every project.
    static func sections(_ answers: [String: HistoryAnswer], project: String = "") -> [HistorySection] {
        let rows = answers.flatMap { machine, answer in answer.threads.map { HistoryRow(machineId: machine, thread: $0) } }
            .filter { project.isEmpty || $0.project == project }
            .sorted { ($0.thread.at, $1.id) > ($1.thread.at, $0.id) }
        var seen = Set<String>()
        var sections: [HistorySection] = []
        for row in rows where seen.insert(row.id).inserted {
            if sections.last?.group == row.thread.group { sections[sections.count - 1].rows.append(row) }
            else { sections.append(HistorySection(group: row.thread.group, label: row.thread.label, rows: [row])) }
        }
        return sections
    }

    /// The projects with a thread in History, by name; with several machines, named by machine too.
    static func projects(_ answers: [String: HistoryAnswer], machineName: ((String) -> String)? = nil) -> [HistoryProject] {
        var named: [String: String] = [:]
        for (machine, answer) in answers {
            for thread in answer.threads where !thread.project.isEmpty {
                let name = machineName.map { "\($0(machine)) · \(thread.project)" } ?? thread.project
                named["\(machine)/\(thread.workspaceId)"] = name
            }
        }
        return named.map { HistoryProject(id: $0.key, name: $0.value) }
            .sorted { ($0.name.localizedLowercase, $0.id) < ($1.name.localizedLowercase, $1.id) }
    }
}

/// History across every paired machine. Each ready machine answers for its own threads
/// (`history.query`); the last answers stay on screen until the next ones arrive.
@MainActor @Observable final class HistoryList {
    enum Phase: Equatable {
        /// No answer yet.
        case loading
        case ready
        /// Every machine asked failed to answer, or none is connected.
        case failed
    }
    private(set) var phase = Phase.loading
    private(set) var answers: [String: HistoryAnswer] = [:]
    @ObservationIgnored private var generation = 0

    func run(_ inbox: MachineInbox, query: String) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Typing settles before machines are asked.
        if !text.isEmpty { try? await Task.sleep(for: .milliseconds(150)) }
        guard !Task.isCancelled, current == generation else { return }
        let sessions = inbox.sessions.filter { $0.client.connection == "ready" }
        guard !sessions.isEmpty else {
            // Still connecting: keep waiting; with every machine down, say so.
            if inbox.sessions.isEmpty || inbox.anyLoaded { phase = answers.isEmpty ? .failed : .ready }
            return
        }
        let asks = sessions.map { session in
            let client = session.client, host = session.hostId
            return Task { () -> (String, HistoryAnswer?) in
                (host, try? await client.service(["type": "history.query", "query": text], as: HistoryAnswer.self))
            }
        }
        var found: [String: HistoryAnswer] = [:]
        await withTaskCancellationHandler {
            for ask in asks { if case let (host, answer?) = await ask.value { found[host] = answer } }
        } onCancel: {
            for ask in asks { ask.cancel() }
        }
        guard !Task.isCancelled, current == generation else { return }
        answers = found
        phase = found.isEmpty ? .failed : .ready
    }
}
