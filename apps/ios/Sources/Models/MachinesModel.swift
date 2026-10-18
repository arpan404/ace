import Foundation
import Observation

/// Paired computers and the one this phone is connected to. Directory rules and credentials
/// stay in the shared SDK and Keychain; this model only selects and switches connections.
@MainActor @Observable final class MachinesModel {
    private(set) var machines: [MachineEntry] = []
    private(set) var activeHostId: String?
    private(set) var loaded = false
    private(set) var grants: [String: [String]]
    var problem: ProblemNotice?
    @ObservationIgnored let client: ClientModel
    @ObservationIgnored private let access: any MachineAccess
    @ObservationIgnored private let storage: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let itemLimit: Int

    init(client: ClientModel, access: any MachineAccess, storage: URL, defaults: UserDefaults = .standard, itemLimit: Int = 2200) {
        self.client = client; self.access = access; self.storage = storage; self.defaults = defaults; self.itemLimit = itemLimit
        grants = defaults.dictionary(forKey: Keys.grants) as? [String: [String]] ?? [:]
        activeHostId = defaults.string(forKey: Keys.active)
    }
    var active: MachineEntry? { machines.first { $0.hostId == activeHostId } }
    /// The host chose a view-only grant for this phone; commands will be refused.
    var activeIsReadOnly: Bool { active.map { !canOperate($0) } ?? false }
    private func canOperate(_ entry: MachineEntry) -> Bool { Grants(scopes: grants[entry.deviceId] ?? ["operate"]).canOperate }

    /// Load the directory, then reconnect to the last machine (or the first one).
    func load() async {
        switch await access.perform(.list) {
        case .success(let outcome): machines = outcome.machines ?? []
        case .failure(let notice): problem = notice
        }
        loaded = true
        if let target = active ?? machines.first { await select(target.hostId) }
    }
    /// Redeem a confirmed link, store the device, then switch to it. Returns the failure, if any.
    func pair(_ link: PairingLink, name: String) async -> ProblemNotice? {
        switch await access.perform(.pair(link, name: name)) {
        case .failure(let notice): return notice
        case .success(let outcome):
            machines = outcome.machines ?? machines
            guard let paired = outcome.paired, let entry = machines.first(where: { $0.hostId == paired.hostId }) else { return .unknown }
            grants[entry.deviceId] = paired.scopes
            defaults.set(grants, forKey: Keys.grants)
            await select(entry.hostId)
            return nil
        }
    }
    /// Await the previous runtime's shutdown before the next one opens its own database.
    func select(_ hostId: String) async {
        guard let entry = machines.first(where: { $0.hostId == hostId }) else { return }
        activeHostId = hostId
        defaults.set(hostId, forKey: Keys.active)
        guard let target = entry.connectionTarget else {
            problem = ProblemNotice(code: "unsupported", message: "This machine needs a direct pinned address. Pair it again.")
            await client.disconnectAndWait()
            return
        }
        problem = nil
        client.canOperate = canOperate(entry)
        await client.connect(target: target, directory: storage, itemLimit: itemLimit)
    }
    /// Remove authority first, then local data bound to that host and device.
    func remove(_ hostId: String) async {
        guard let entry = machines.first(where: { $0.hostId == hostId }) else { return }
        let wasActive = activeHostId == hostId
        if wasActive { await client.disconnectAndWait() }
        switch await access.perform(.remove(hostId: hostId)) {
        case .failure(let notice):
            if wasActive { await select(hostId) }
            problem = notice
            return
        case .success(let outcome): machines = outcome.machines ?? machines.filter { $0.hostId != hostId }
        }
        grants[entry.deviceId] = nil
        defaults.set(grants, forKey: Keys.grants)
        let database = ClientModel.database(hostId: entry.hostId, deviceId: entry.deviceId, in: storage)
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(at: URL(fileURLWithPath: database.path + suffix)) }
        if wasActive {
            activeHostId = nil
            defaults.removeObject(forKey: Keys.active)
            if let next = machines.first { await select(next.hostId) }
        }
    }
    private enum Keys {
        static let grants = "ace.machines.grants"
        static let active = "ace.machines.active"
    }
}
