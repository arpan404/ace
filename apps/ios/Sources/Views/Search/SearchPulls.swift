import Observation
import SwiftUI

/// A pull request Search found: its row, and the page it opens.
struct FoundPull: Identifiable, Equatable {
    let route: ForgeRoute
    let row: ForgePullRow
    var id: String { row.key }
}

/// Pull requests matching a query in the project Pull requests opens on (the one chosen there
/// last, else the machine's first), read from the machine's forge search. The last answer stays
/// until the next one arrives; a newer query cancels the older read. A read that fails says so
/// above the rows it last found, and can be asked again.
@MainActor @Observable final class SearchPulls {
    static let shown = 3
    private(set) var found: [FoundPull] = []
    /// Why the last read didn't answer: its sentence stays over the rows found before it.
    private(set) var problem: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var asked = ""

    func run(_ inbox: MachineInbox, query: String) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        asked = text
        guard text.count >= 2 else { found = []; problem = nil; return }
        // Typing settles before the machine is asked.
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, current == generation,
              let session = inbox.sessions.first(where: { $0.client.connection == "ready" }) else { return }
        let client = session.client
        let remembered = UserDefaults.standard.string(forKey: ForgeProjectChoice.key)
        do {
            let projects = try await client.forgeProjects()
            guard let project = ForgeProjectChoice.pick(chip: "", remembered: remembered, projects: projects) else {
                // No project to search: not a failure, just nothing to offer.
                guard current == generation else { return }
                found = []; problem = nil
                return
            }
            let list = try await client.forgePulls(project: project, filter: PullsFilter(), query: text, screens: 1, fresh: false)
            guard !Task.isCancelled, current == generation else { return }
            found = list.groups.flatMap(\.rows).prefix(Self.shown).map { row in
                FoundPull(route: ForgeRoute(kind: .pull, machineId: session.hostId, project: project, number: row.number, repository: row.repository),
                          row: row)
            }
            problem = nil
        } catch {
            guard !Task.isCancelled, current == generation else { return }
            // A machine that answered with a refusal (no Git host, a folder that isn't a
            // repository) has no pull requests to offer: that's nothing found, not a failure.
            // A read that got no answer, or one that couldn't be understood, is worth Retry.
            if let failure = error as? ServiceFailure, !failure.transport { found = []; problem = nil; return }
            problem = "Couldn't search pull requests. Check the connection and try again."
        }
    }

    /// The same query again, after its read failed.
    func retry(_ inbox: MachineInbox) async {
        guard !asked.isEmpty else { return }
        await run(inbox, query: asked)
    }
}
