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

/// Counts the changes History must read again for: a thread entering or leaving Settled, or a
/// settled thread's row changing (renamed, worked again). Rows elsewhere in the list never count,
/// so a working thread's stream doesn't re-read History.
struct HistoryRevision: Equatable {
    private(set) var value = 0
    private var settled: Set<String> = []

    mutating func layout(_ layout: InboxLayout) {
        let now = Set(layout.sections.filter { ($0.tab ?? $0.key) == "settled" }.flatMap(\.ids))
        guard now != settled else { return }
        settled = now
        value &+= 1
    }
    mutating func row(_ id: String, old: ThreadRow?, new: ThreadRow?) {
        guard settled.contains(id), old != new else { return }
        value &+= 1
    }
    mutating func reset() { value &+= 1 }
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

/// Every machine's History as one list: newest first, each thread once, under the week groups
/// the machines filed them in (`historyGroupOf`, against the moment `HistoryList` sends). Pure, so the rules are tested without a machine.
enum HistoryMerge {
    /// `project` is "machine/workspace", or empty for every project.
    static func sections(_ answers: [String: HistoryAnswer], project: String = "") -> [HistorySection] {
        let rows = answers.flatMap { machine, answer in answer.threads.map { HistoryRow(machineId: machine, thread: $0) } }
            .filter { project.isEmpty || $0.project == project }
            .sorted { ($0.thread.at, $1.id) > ($1.thread.at, $0.id) }
        var seen = Set<String>()
        var sections: [HistorySection] = []
        // Every machine groups against the one moment the phone sends; a group still met twice
        // (an answer kept from an earlier read) joins its first section, so each shows once.
        for row in rows where seen.insert(row.id).inserted {
            if let index = sections.firstIndex(where: { $0.group == row.thread.group }) { sections[index].rows.append(row) }
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
        /// No answer yet, while a machine is still making its first connection.
        case loading
        case ready
        /// No machine could answer: none is paired, every one is out of reach, or every one asked
        /// failed to answer.
        case failed
    }
    typealias Sleep = @Sendable (Duration) async throws -> Void

    private(set) var phase = Phase.loading
    private(set) var answers: [String: HistoryAnswer] = [:]
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var answered: String?
    /// The query older threads were paged in for, and the machines already asked to page for it.
    @ObservationIgnored private var pagedQuery: String?
    @ObservationIgnored private var pagedHosts: Set<String> = []
    /// The phone's clock in ms: every machine groups and dates against the same moment.
    @ObservationIgnored private let now: () -> Double
    /// How long a first connection may take before History says it can't reach any machine.
    @ObservationIgnored private let patience: Duration
    @ObservationIgnored private let sleep: Sleep

    init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, patience: Duration = .seconds(10),
         sleep: @escaping Sleep = { try await Task.sleep(for: $0) }) {
        self.now = now
        self.patience = patience
        self.sleep = sleep
    }

    /// What History shows with no machine ready to ask, by each paired machine's connection.
    nonisolated static func phaseWithoutAnswers(_ connections: [String]) -> Phase {
        connections.contains { $0 == "connecting" || $0 == "starting" } ? .loading : .failed
    }

    /// Each machine's answer, keeping the last answer to the same query from every still-paired
    /// machine that didn't answer this time (it failed, or is disconnected), so one machine's
    /// blip doesn't empty its threads from the list.
    nonisolated static func merged(found: [String: HistoryAnswer], paired: [String], previous: [String: HistoryAnswer],
                                   sameQuery: Bool) -> (answers: [String: HistoryAnswer], phase: Phase) {
        var answers = found
        if sameQuery { for host in paired where found[host] == nil { answers[host] = previous[host] } }
        return (answers, answers.isEmpty ? .failed : .ready)
    }

    /// Whether this read asks `host` to page older threads in for `query`: once per machine and
    /// query, claimed before it is asked, so a read restarted by the paging's own arrival, or
    /// cancelled midway, never asks again.
    private func claimsOlder(_ host: String, query: String) -> Bool {
        if pagedQuery != query { pagedQuery = query; pagedHosts = [] }
        return pagedHosts.insert(host).inserted
    }

    func run(_ inbox: MachineInbox, query: String) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Typing settles before machines are asked.
        if !text.isEmpty { try? await sleep(.milliseconds(150)) }
        guard !Task.isCancelled, current == generation else { return }
        let paired = inbox.sessions.map(\.hostId)
        let sessions = inbox.sessions.filter { $0.client.connection == "ready" }
        guard !sessions.isEmpty else {
            // No machine to ask: what is kept for this query from machines still paired stays.
            answers = answered == text ? answers.filter { paired.contains($0.key) } : [:]
            if !answers.isEmpty { phase = .ready; return }
            let waiting = Self.phaseWithoutAnswers(inbox.sessions.map(\.client.connection))
            phase = waiting
            // A machine still connecting gets a while; one that never gets there is out of reach.
            guard waiting == .loading else { return }
            do { try await sleep(patience) } catch { return }
            if !Task.isCancelled, current == generation, answers.isEmpty { phase = .failed }
            return
        }
        let reference = now()
        let asks = sessions.map { session in
            let client = session.client, host = session.hostId
            // Older threads page in once per machine and query (`claimsOlder`).
            let request: [String: Any] = ["type": "history.query", "query": text, "now": reference,
                                          "older": claimsOlder(host, query: text)]
            return Task { () -> (String, HistoryAnswer?) in
                (host, try? await client.service(request, as: HistoryAnswer.self))
            }
        }
        var found: [String: HistoryAnswer] = [:]
        await withTaskCancellationHandler {
            for ask in asks { if case let (host, answer?) = await ask.value { found[host] = answer } }
        } onCancel: {
            // Cancelling an ask cancels its service, which stops the machine's search and paging.
            for ask in asks { ask.cancel() }
        }
        guard !Task.isCancelled, current == generation else { return }
        let result = Self.merged(found: found, paired: paired, previous: answers, sameQuery: answered == text)
        answers = result.answers
        phase = result.phase
        answered = text
    }
}
