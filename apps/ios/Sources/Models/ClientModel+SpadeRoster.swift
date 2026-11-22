import Foundation

extension MachineInbox {
    /// The space shown's machines that show Spade, as the Spade tab's one list merges them. A
    /// machine out of reach keeps its last rows, which its runtime put as away.
    var spadeMachines: [SpadeRoster.Machine] {
        spadeSessions.map { session in
            let spade = session.client.spade
            return SpadeRoster.Machine(key: session.hostId, name: name(session.hostId), host: spade.host ?? session.hostId,
                                       answering: Self.answers(session), record: spade.main?.record, bots: spade.bots ?? [])
        }
    }

    /// Spade once, then every other bot of the space's machines (`SpadeRoster.merge`).
    var spadeRoster: [SpadeRoster.Entry] { SpadeRoster.merge(spadeMachines) }

    /// The machines whose Spade answers now: where a new bot can run.
    var spadeHosts: [MachineSession] { spadeSessions.filter(Self.answers) }

    private static func answers(_ session: MachineSession) -> Bool {
        session.client.connection == "ready" && session.client.spade.line?.ready == true
    }
}
