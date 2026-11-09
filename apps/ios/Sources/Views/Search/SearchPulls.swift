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
/// until the next one arrives; a newer query cancels the older read.
@MainActor @Observable final class SearchPulls {
    static let shown = 3
    private(set) var found: [FoundPull] = []
    @ObservationIgnored private var generation = 0

    func run(_ inbox: MachineInbox, query: String) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { found = []; return }
        // Typing settles before the machine is asked.
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, current == generation,
              let session = inbox.sessions.first(where: { $0.client.connection == "ready" }) else { return }
        let client = session.client
        let remembered = UserDefaults.standard.string(forKey: ForgeProjectChoice.key)
        guard let projects = try? await client.forgeProjects(),
              let project = ForgeProjectChoice.pick(chip: "", remembered: remembered, projects: projects),
              let list = try? await client.forgePulls(project: project, filter: PullsFilter(), query: text, screens: 1, fresh: false),
              !Task.isCancelled, current == generation else { return }
        found = list.groups.flatMap(\.rows).prefix(Self.shown).map { row in
            FoundPull(route: ForgeRoute(kind: .pull, machineId: session.hostId, project: project, number: row.number, repository: row.repository),
                      row: row)
        }
    }
}
