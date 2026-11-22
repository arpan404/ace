import Foundation

/// The Spade tab's one list across the space's machines, as web's roster lists it
/// (`use-spade-roster.ts`): Spade once, from the machine the fleet chose to host it, then every
/// other bot and group by state and latest activity, each with its machine. Each machine's
/// runtime already says its rows (away and unavailable ones never read as working); this only
/// merges them. The election follows `spadeShownMain` in `@ace/ui-core/spade-chat`, the rule web
/// uses; Swift repeats it because each machine runs in its own JavaScript runtime. Pure.
enum SpadeRoster {
    /// One machine that shows Spade, as its runtime last put it.
    struct Machine: Equatable, Sendable {
        /// The inbox's host id: what routes an action to its runtime.
        let key: String
        let name: String
        /// Its ace host id, as host records name it; nil until it has said.
        let host: String?
        /// Its connection is ready and its Spade answers now.
        let answering: Bool
        /// The host choice it holds, from its last answer.
        let record: SpadeModel.HostRecord?
        let bots: [SpadeModel.Bot]
    }

    /// A row of the list: a bot or group, and the machine it runs on.
    struct Entry: Equatable, Sendable, Identifiable {
        let machine: String
        let machineName: String
        let bot: SpadeModel.Bot
        /// Ids repeat between machines' Spades: the machine keeps them apart.
        var id: String { "\(machine)/\(bot.id)" }
    }

    static func merge(_ machines: [Machine]) -> [Entry] {
        var mains: [(entry: Entry, created: Double, host: String?, answering: Bool)] = []
        var rest: [Entry] = []
        for machine in machines {
            for bot in machine.bots {
                let entry = Entry(machine: machine.key, machineName: machine.name, bot: bot)
                if bot.main { mains.append((entry, bot.createdAt ?? 0, machine.host, machine.answering)) }
                else { rest.append(entry) }
            }
        }
        let shown: Entry?
        if let choice = newest(machines.compactMap(\.record)) {
            shown = mains.first { $0.host == choice.host }?.entry
        } else {
            shown = mains.filter { $0.answering }.min { a, b in
                a.created != b.created ? a.created < b.created : jsBefore(a.entry.machine, b.entry.machine)
            }?.entry
        }
        let ordered = rest.enumerated().sorted { a, b in
            let (x, y) = (a.element.bot, b.element.bot)
            if (x.rank ?? 4) != (y.rank ?? 4) { return (x.rank ?? 4) < (y.rank ?? 4) }
            if (x.at ?? 0) != (y.at ?? 0) { return (x.at ?? 0) > (y.at ?? 0) }
            // Same rank and time: the order machines and their runtimes gave.
            return a.offset < b.offset
        }.map { $0.element }
        return (shown.map { [$0] } ?? []) + ordered
    }

    /// The newest of the machines' host records: the higher version, then the later time, then
    /// the higher host id, as `newerSpadeHost` decides.
    static func newest(_ records: [SpadeModel.HostRecord]) -> SpadeModel.HostRecord? {
        records.reduce(nil as SpadeModel.HostRecord?) { newest, record in
            guard let newest else { return record }
            return newer(record, than: newest) ? record : newest
        }
    }

    private static func newer(_ a: SpadeModel.HostRecord, than b: SpadeModel.HostRecord) -> Bool {
        if a.version != b.version { return a.version > b.version }
        if a.at != b.at { return a.at > b.at }
        return jsBefore(b.host, a.host)
    }

    /// Whether `a` sorts before `b` as JavaScript compares strings (by UTF-16 code unit), so
    /// every client breaks a tie the same way.
    private static func jsBefore(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }
}
