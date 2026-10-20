import Foundation
import Observation

/// One paired computer's live runtime. Each has its own JavaScriptCore VM, socket, outbox
/// database and Keychain key (see `ClientRuntime`, `HostServices.connection`).
final class MachineSession: Identifiable {
    let hostId: String
    let client: ClientModel
    var id: String { hostId }
    init(hostId: String, client: ClientModel) { self.hostId = hostId; self.client = client }
}

/// The inbox across every paired machine: which runtime owns a row, what a machine is called and
/// when this phone last saw it. A row, an action and an opened thread always route to the
/// runtime of the machine the row came from; one machine's trouble never touches another's rows.
@MainActor @Observable final class MachineInbox {
    private(set) var sessions: [MachineSession] = []
    private(set) var names: [String: String] = [:]
    private var seen: [String: Double]
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: () -> Double
    @ObservationIgnored private var memo: (inputs: [(String, InboxLayout)], merged: MergedInbox)?

    init(defaults: UserDefaults = .standard, now: @escaping () -> Double) {
        self.defaults = defaults; self.now = now
        seen = defaults.dictionary(forKey: Self.seenKey) as? [String: Double] ?? [:]
    }

    /// Machine names show on rows only when there is more than one machine to tell apart.
    var showsMachineNames: Bool { sessions.count > 1 }
    func client(_ hostId: String) -> ClientModel? { sessions.first { $0.hostId == hostId }?.client }
    func name(_ hostId: String) -> String { names[hostId] ?? hostId }
    func row(_ key: InboxKey) -> ThreadRow? { client(key.machineId)?.inbox[key.id] }
    func pending(_ key: InboxKey) -> PendingRow? { client(key.machineId)?.pending[key.id] }

    /// Every machine's shared sections, merged by rank. Recomputed only when a layout changed.
    var merged: MergedInbox {
        let inputs = sessions.map { ($0.hostId, $0.client.inboxLayout) }
        if let memo, memo.inputs.count == inputs.count,
           zip(memo.inputs, inputs).allSatisfy({ $0.0 == $1.0 && $0.1 == $1.1 }) { return memo.merged }
        let merged = MergedInbox.merge(inputs.map { (machineId: $0.0, layout: $0.1) })
        memo = (inputs, merged)
        return merged
    }
    var allReady: Bool { !sessions.isEmpty && sessions.allSatisfy { $0.client.connection == "ready" } }
    var anyLoaded: Bool { sessions.contains { $0.client.inboxLoaded } }

    func attach(_ hostId: String, name: String, client: ClientModel) {
        names[hostId] = name
        if let index = sessions.firstIndex(where: { $0.hostId == hostId }) { sessions[index] = MachineSession(hostId: hostId, client: client) }
        else { sessions.append(MachineSession(hostId: hostId, client: client)) }
    }
    @discardableResult func detach(_ hostId: String) -> ClientModel? {
        guard let index = sessions.firstIndex(where: { $0.hostId == hostId }) else { return nil }
        names[hostId] = nil
        forget(hostId)
        return sessions.remove(at: index).client
    }
    func rename(_ hostId: String, to name: String) { names[hostId] = name }

    /// When this phone last saw the machine (epoch ms): now while connected, else the bridge's
    /// drop time or what an earlier launch recorded.
    func lastSeen(_ hostId: String) -> Double? {
        guard let client = client(hostId) else { return seen[hostId] }
        if client.connection == "ready" { return now() }
        return [seen[hostId], client.machineStatus?.seenAt].compactMap { $0 }.max()
    }
    /// Persist last-seen times, such as when the app leaves the foreground.
    func recordSeen() {
        for session in sessions { if let value = lastSeen(session.hostId) { seen[session.hostId] = value } }
        defaults.set(seen, forKey: Self.seenKey)
    }
    private func forget(_ hostId: String) {
        seen[hostId] = nil
        defaults.set(seen, forKey: Self.seenKey)
    }
    private static let seenKey = "ace.machines.lastSeen"
}
