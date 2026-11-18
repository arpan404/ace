import Observation
import SwiftUI

/// A pull request Search found: its row, and the page it opens.
struct FoundPull: Identifiable, Equatable {
    let route: ForgeRoute
    let row: ForgePullRow
    /// The connection it was read on: which client, and which of its daemon sockets.
    let connection: ConnectionStamp
    var id: String { row.key }
}

/// One connection to a machine: the client model (a machine paired again gets a new one, whose
/// socket numbers start again) and the daemon socket it was ready on (`ClientModel.socket`).
/// The client is held weakly, so a freed model never matches a new one at the same address.
struct ConnectionStamp: Equatable {
    private weak var client: ClientModel?
    private let socket: Int

    /// `client`'s connection now, or nil while it isn't ready on a socket the bridge named.
    @MainActor init?(_ client: ClientModel) {
        guard client.connection == "ready", let socket = client.socket else { return nil }
        self.client = client
        self.socket = socket
    }

    static func == (a: ConnectionStamp, b: ConnectionStamp) -> Bool {
        a.client != nil && a.client === b.client && a.socket == b.socket
    }
}

/// Pull requests matching a query in the project Pull requests opens on (the one chosen there
/// last, else the machine's first), read from the machine's forge search. The last answer stays
/// until the next one arrives; a newer query cancels the older read. A read that fails says so
/// above the rows it last found, and can be asked again. Rows belong to the connection they were
/// read on: once their machine drops, they never show again, even after it reconnects or is
/// paired again.
@MainActor @Observable final class SearchPulls {
    /// One machine's pull requests matching a query: the project it searched and the rows, or
    /// nil when it has no project to search. The app reads the machine's forge (`forge`).
    typealias Read = @MainActor (ClientModel, String) async throws -> (project: String, rows: [ForgePullRow])?

    static let shown = 3
    private(set) var found: [FoundPull] = []
    /// Why the last read didn't answer: its sentence stays over the rows found before it.
    private(set) var problem: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var asked = ""
    @ObservationIgnored private let read: Read

    init(read: @escaping Read = SearchPulls.forge) { self.read = read }

    /// The rows to draw: only those read on their machine's current, ready connection. A row
    /// never opens on a machine that has gone, nor shows again after it reconnects, whether or
    /// not a search has run since.
    func visible(_ inbox: MachineInbox) -> [FoundPull] {
        found.filter { Self.current($0, inbox) }
    }

    func run(_ inbox: MachineInbox, query: String) async {
        generation += 1
        let current = generation
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        asked = text
        // Rows from a machine that went away, or from before it reconnected, go before anything
        // is asked, whatever the next read does.
        found = found.filter { Self.current($0, inbox) }
        // Nothing to ask, or no machine to ask it.
        guard text.count >= 2, inbox.sessions.contains(where: { $0.client.connection == "ready" }) else { found = []; problem = nil; return }
        // Typing settles before the machine is asked.
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, current == generation,
              let session = inbox.sessions.first(where: { $0.client.connection == "ready" }) else { return }
        guard let connection = ConnectionStamp(session.client) else { return }
        do {
            guard let answer = try await read(session.client, text) else {
                // No project to search: not a failure, just nothing to offer.
                guard current == generation else { return }
                found = []; problem = nil
                return
            }
            guard !Task.isCancelled, current == generation else { return }
            found = answer.rows.prefix(Self.shown).map { row in
                FoundPull(route: ForgeRoute(kind: .pull, machineId: session.hostId, project: answer.project, number: row.number,
                                            repository: row.repository),
                          row: row, connection: connection)
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

    private static func current(_ found: FoundPull, _ inbox: MachineInbox) -> Bool {
        inbox.client(found.route.machineId).flatMap(ConnectionStamp.init) == found.connection
    }

    /// The machine's forge search, in the project Pull requests opens on (the one chosen there
    /// last, else the machine's first).
    static func forge(_ client: ClientModel, _ query: String) async throws -> (project: String, rows: [ForgePullRow])? {
        let remembered = UserDefaults.standard.string(forKey: ForgeProjectChoice.key)
        let projects = try await client.forgeProjects()
        guard let project = ForgeProjectChoice.pick(chip: "", remembered: remembered, projects: projects) else { return nil }
        let list = try await client.forgePulls(project: project, filter: PullsFilter(), query: query, screens: 1, fresh: false)
        return (project: project, rows: list.groups.flatMap(\.rows))
    }
}
