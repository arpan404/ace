/// What a thread's screen says while its rows aren't the machine's own yet: a thread opened right
/// after launch waits for the connection, and the page is never left blank meanwhile. Rows kept
/// from an earlier session show at once, marked as syncing, and are updated in place. Pure.
enum ThreadOpening: Equatable, Sendable {
    /// The rows on screen are current: nothing to add.
    case none
    /// Nothing to show yet on a connected machine.
    case loading
    /// Nothing to show yet: the machine isn't connected.
    case connecting(machine: String?)
    /// Nothing to show, and the connection failed for `reason`.
    case failed(reason: String)
    /// Kept rows on screen while the machine connects.
    case syncing(machine: String?)
    /// Kept rows on screen, and the connection failed for `reason`.
    case syncFailed(reason: String)

    struct Facts: Equatable, Sendable {
        /// The thread has a first screen (`ThreadModel.loaded`).
        var loaded: Bool
        /// Rows that first screen holds.
        var rows: Int
        /// The runtime's connection state: "starting", "connecting", "ready", "reconnecting", ...
        var connection: String
        /// Why the connection isn't ready, in a person's words (`ClientModel.problem`).
        var problem: String?
        /// The machine's name, as the thread's row has it.
        var machine: String?
    }

    static func of(_ facts: Facts) -> ThreadOpening {
        let ready = facts.connection == "ready"
        let failure = ready ? nil : facts.problem.flatMap { $0.isEmpty ? nil : $0 }
        if facts.loaded, facts.rows > 0 {
            if ready { return .none }
            if let failure { return .syncFailed(reason: failure) }
            return .syncing(machine: facts.machine)
        }
        if let failure { return .failed(reason: failure) }
        if !ready { return .connecting(machine: facts.machine) }
        return facts.loaded ? .none : .loading
    }

    /// A placeholder stands where the rows go: there are none to show yet.
    var coversRows: Bool {
        switch self {
        case .loading, .connecting, .failed: true
        case .none, .syncing, .syncFailed: false
        }
    }

    /// The connection can be asked for again from here.
    var retries: Bool {
        switch self {
        case .failed, .syncFailed: true
        default: false
        }
    }

    /// The one line it says, if any.
    var words: String? {
        switch self {
        case .none: nil
        case .loading: "Loading…"
        case .connecting(let machine), .syncing(let machine): "Connecting to \(Self.name(machine))…"
        case .failed(let reason), .syncFailed(let reason): reason
        }
    }

    private static func name(_ machine: String?) -> String {
        guard let machine, !machine.isEmpty else { return "your computer" }
        return machine
    }
}
