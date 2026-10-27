import Foundation
import Observation

/// One machine's answer to the search-everything sheet (`PaletteAnswer` in `bridge/palette.ts`).
struct PaletteAnswer: Decodable, Sendable, Equatable {
    struct Command: Decodable, Sendable, Equatable, Identifiable { let id: String; let label: String; let detail: String?; let score: Double }
    struct Project: Decodable, Sendable, Equatable { let id: String; let name: String; let score: Double }
    struct Thread: Decodable, Sendable, Equatable {
        let id: String; let title: String; let project: String
        /// On the machine's list now; otherwise found by its search (archived or older).
        let listed: Bool
        let at: Double; let score: Double
    }
    let commands: [Command]
    let projects: [Project]
    let threads: [Thread]
}

/// A project or thread found on one machine.
struct FoundProject: Identifiable, Equatable { let machineId: String; let project: PaletteAnswer.Project; var id: String { "\(machineId)/\(project.id)" } }
struct FoundThread: Identifiable, Equatable { let machineId: String; let thread: PaletteAnswer.Thread; var id: String { "\(machineId)/\(thread.id)" } }

/// The search-everything sheet's commands, projects and threads across every paired machine.
/// The shared runtime ranks each machine's own (`palette.query`); this keeps the last answer on
/// screen until the next one arrives and merges the machines by score.
@MainActor @Observable final class SearchEverything {
    private(set) var commands: [PaletteAnswer.Command] = []
    private(set) var projects: [FoundProject] = []
    private(set) var threads: [FoundThread] = []
    @ObservationIgnored private var generation = 0

    func run(_ inbox: MachineInbox, query: String, threadOpen: Bool) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Typing settles before machines are asked; an empty query lists commands at once.
        if !text.isEmpty { try? await Task.sleep(for: .milliseconds(150)) }
        guard !Task.isCancelled, current == generation else { return }
        let sessions = inbox.sessions.filter { $0.client.connection == "ready" }
        let commander = sessions.first(where: { $0.client.canOperate })?.hostId ?? sessions.first?.hostId
        let answers = await withTaskGroup(of: (String, PaletteAnswer?).self) { group in
            for session in sessions {
                let client = session.client
                let request: [String: Any] = [
                    "type": "palette.query", "query": text, "commands": session.hostId == commander,
                    "context": ["canStart": inbox.canStartThreads, "threadOpen": threadOpen],
                ]
                group.addTask { @MainActor in (session.hostId, try? await client.service(request, as: PaletteAnswer.self)) }
            }
            var all: [(String, PaletteAnswer)] = []
            for await (host, answer) in group { if let answer { all.append((host, answer)) } }
            return all
        }
        guard !Task.isCancelled, current == generation else { return }
        commands = answers.flatMap(\.1.commands)
        projects = answers.flatMap { host, answer in answer.projects.map { FoundProject(machineId: host, project: $0) } }
            .sorted { $0.project.score > $1.project.score }
        threads = answers.flatMap { host, answer in answer.threads.map { FoundThread(machineId: host, thread: $0) } }
            .sorted { ($0.thread.score, $0.thread.at) > ($1.thread.score, $1.thread.at) }
    }
}

/// The last eight searches on this phone, newest first (the web's `search-recent.ts`).
struct RecentSearches {
    static let key = "ace.search.recent"
    static let keep = 8
    static func adding(_ query: String, to list: [String]) -> [String] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return list }
        return Array(([String(text.prefix(512))] + list.filter { $0 != text }).prefix(keep))
    }
    static func read(_ defaults: UserDefaults) -> [String] { Array((defaults.stringArray(forKey: key) ?? []).prefix(keep)) }
}
