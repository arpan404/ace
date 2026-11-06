import Foundation
import os

/// The sends an account machine's runtime saved, moving into the paired machine it turned out to
/// be (ADR 0115), safe across a crash or a failed write. Each move is written down before the
/// machine list changes and done again on every launch and list change until its destination
/// has committed; only then does the record go. A move that fails is logged once and tried again.
///
/// A machine that took sends in is `linking` until its relay has been ready once: those sends
/// may have run under the account's device id, and only the relay's hello, which proves the
/// pairing, links that id to the paired one on the daemon (`MachineRoutePlan.linking`).
@MainActor final class SendAdoptions {
    /// Sends of `sourceHost`'s store, under `sourceDevice`, going to `host`'s, under `device`.
    struct Adoption: Codable, Hashable, Sendable {
        let sourceHost: String, sourceDevice: String, host: String, device: String
    }
    /// Moves the sends bound to `daemon` from one store into another; how many it found.
    typealias Move = @Sendable (_ from: URL, _ into: URL, _ daemon: String) async throws -> Int
    nonisolated static let durable: Move = { from, into, daemon in
        try await Task.detached { try DurableStore.adopt(from: from, into: into, daemon: daemon) }.value
    }
    private static let log = Logger(subsystem: "app.ace.ios", category: "machines")
    private let defaults: UserDefaults
    private let storage: URL
    private let move: Move
    private(set) var pending: [Adoption]
    private(set) var linking: Set<String>
    /// Moves whose failure was already logged, so a retry that fails again stays quiet.
    private var reported: Set<Adoption> = []
    private var replaying = false
    private var again = false

    init(defaults: UserDefaults, storage: URL, move: @escaping Move) {
        self.defaults = defaults; self.storage = storage; self.move = move
        pending = defaults.data(forKey: Keys.pending).flatMap { try? JSONDecoder().decode([Adoption].self, from: $0) } ?? []
        linking = Set(defaults.stringArray(forKey: Keys.linking) ?? [])
    }
    /// Written down before the list that drops the sources is saved.
    func record(_ adoptions: [Adoption]) {
        let fresh = adoptions.filter { !pending.contains($0) }
        guard !fresh.isEmpty else { return }
        pending += fresh
        save()
    }
    /// `hostId` was removed on purpose: no move goes from or into it any more.
    func forget(_ hostId: String) {
        let kept = pending.filter { $0.sourceHost != hostId && $0.host != hostId }
        if kept != pending { pending = kept; save() }
        if linking.remove(hostId) != nil { save() }
    }
    /// `hostId`'s relay was ready: the daemon holds the link, and its route is its own again.
    func linked(_ hostId: String) {
        if linking.remove(hostId) != nil { save() }
    }
    /// Does every move whose source no longer runs or is listed (`inUse`), in order. The machines
    /// whose stores took sends in are returned, for their runtimes to read them; a call made while
    /// another is under way has it run once more and returns none.
    func replay(inUse: (String) -> Bool) async -> [String] {
        if replaying { again = true; return [] }
        replaying = true
        defer { replaying = false }
        var gained: [String] = []
        repeat {
            again = false
            for adoption in pending where !inUse(adoption.sourceHost) {
                if await run(adoption), !gained.contains(adoption.host) { gained.append(adoption.host) }
            }
        } while again
        return gained
    }
    /// Whether sends moved. The destination links first, before anything is moved: a crash
    /// after the move still finds it linking.
    private func run(_ adoption: Adoption) async -> Bool {
        let source = ClientModel.database(hostId: adoption.sourceHost, deviceId: adoption.sourceDevice, in: storage)
        let destination = ClientModel.database(hostId: adoption.host, deviceId: adoption.device, in: storage)
        let wasLinking = linking.contains(adoption.host)
        if !wasLinking { linking.insert(adoption.host); save() }
        do {
            let moved = try await move(source, destination, adoption.host)
            pending.removeAll { $0 == adoption }
            reported.remove(adoption)
            if moved == 0, !wasLinking { linking.remove(adoption.host) }
            save()
            return moved > 0
        } catch {
            if reported.insert(adoption).inserted {
                Self.log.error("Saved sends of \(adoption.sourceHost, privacy: .private) couldn't move yet: \(String(describing: error), privacy: .public)")
            }
            return false
        }
    }
    private func save() {
        defaults.set(try? JSONEncoder().encode(pending), forKey: Keys.pending)
        defaults.set(linking.sorted(), forKey: Keys.linking)
    }
    private nonisolated enum Keys {
        static let pending = "ace.machines.pendingAdoptions", linking = "ace.machines.linking"
    }
}
