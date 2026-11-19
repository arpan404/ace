import Foundation

/// The phone's ace account as the machine list sees it: which machines are on it, how to reach
/// one through ace's relay, and forgetting one.
protocol AccountDirectory: Sendable {
    /// This phone's device id on the account.
    var deviceId: String { get }
    /// ace's hosted relay for this account.
    var relayURL: URL? { get }
    /// Nil when signed out; `AccountGrantError.unavailable` keeps the last list.
    func machines() async throws(AccountGrantError) -> [AceMachine]?
    func forget(_ hostId: String) async throws(AccountGrantError)
    func route(hostId: String) -> RelayRoute?
}

struct AceAccountDirectory: AccountDirectory {
    let api: AceAccountAPI
    let session: AceAccountSessionStore
    let deviceId: String

    init?(settings: Bundle = .main, install: InstallIdentity = .system) {
        guard let origin = AceAccountAPI.origin(from: settings.object(forInfoDictionaryKey: "AceAccountURL") as? String) else { return nil }
        api = AceAccountAPI(origin: origin)
        session = AceAccountSessionStore(origin: origin)
        deviceId = session.deviceId(install: install)
    }
    var relayURL: URL? { api.relayURL }
    func machines() async throws(AccountGrantError) -> [AceMachine]? {
        guard let token = session.token() else { return nil }
        do { return try await api.machines(token: token) }
        catch AccountGrantError.signedOut { return nil }
    }
    func forget(_ hostId: String) async throws(AccountGrantError) {
        guard let token = session.token() else { throw .signedOut }
        try await api.forget(token: token, hostId: hostId)
    }
    func route(hostId: String) -> RelayRoute? {
        guard let relay = api.relayURL else { return nil }
        return RelayRoute(relayURL: relay, hostId: hostId, grants: AccountGrants(api: api, session: session, deviceId: deviceId))
    }
}

enum AccountMachines {
    /// The target kind of a machine reached through the account, never stored in the SDK directory.
    static let kind = "account"

    /// Paired machines first, then account machines that aren't paired: a machine on both is
    /// listed once (ADR 0115), as its paired entry, keeping both routes. A paired entry is an
    /// account machine when the daemon said so over an authenticated connection: its own paths
    /// name that relay host id, or that account machine's daemon answered with the paired id
    /// (`daemons`, account host id → daemon id). Pure.
    static func merge(paired: [MachineEntry], account: [AceMachine], relayURL: String, deviceId: String,
                      daemons: [String: String] = [:]) -> [MachineEntry] {
        var claimed = Set(paired.map(\.hostId))
        let merged = paired.map { entry -> MachineEntry in
            let match = account.first { machine in
                !claimed.contains(machine.hostId) && (entry.relayHostIds.contains(machine.hostId) || daemons[machine.hostId] == entry.hostId)
            }
            var entry = entry
            entry.accountHostId = match?.hostId
            if let match { claimed.insert(match.hostId) }
            return entry
        }
        let added = account.filter { !claimed.contains($0.hostId) }.map { machine in
            MachineEntry(hostId: machine.hostId, displayName: machine.name.isEmpty ? "Machine" : machine.name, icon: nil,
                         target: .init(kind: kind, url: relayURL, fingerprint: machine.hostId), deviceId: deviceId)
        }
        return merged + added
    }
}

extension MachineEntry {
    var isAccountMachine: Bool { target.kind == AccountMachines.kind }
}

/// Why an account machine asks for its machine code (ADR 0111).
enum MachineCodeAsk: String, Sendable, Equatable {
    case required = "machine_code_required"
    case wrong = "machine_code_wrong"
    case locked = "machine_code_locked"

    func message(lockedUntil: Date? = nil) -> String {
        switch self {
        case .required: "This machine has a machine code. Enter it once to open it from this phone."
        case .wrong: "That code isn't right. Try again."
        case .locked:
            if let lockedUntil {
                "Too many wrong codes. Try again at \(lockedUntil.formatted(date: .omitted, time: .shortened))."
            } else {
                "Too many wrong codes. Code entry on this machine is paused for 15 minutes."
            }
        }
    }
    var canEnter: Bool { self != .locked }
}
