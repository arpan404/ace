import Foundation
import Observation

/// Paired computers, each connected at once on its own runtime. Directory rules and credentials
/// stay in the shared SDK and Keychain; this model starts, renames and retires runtimes.
@MainActor @Observable final class MachinesModel {
    /// Remembered on every change, so the next launch connects them before the directory answers.
    private(set) var machines: [MachineEntry] = [] {
        didSet { if machines != oldValue { defaults.set(try? JSONEncoder().encode(machines), forKey: Keys.known) } }
    }
    private(set) var loaded = false
    private(set) var grants: [String: [String]]
    /// Directory trouble, or an operation on a machine that failed (for a person).
    var problem: ProblemNotice?
    /// Machines stored without a pinned direct address; they need pairing again.
    private(set) var unsupported: Set<String> = []
    let inbox: MachineInbox
    @ObservationIgnored private let access: any MachineAccess
    @ObservationIgnored private let storage: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let itemLimit: Int
    @ObservationIgnored private let makeClient: @MainActor () -> ClientModel
    /// Runs before each machine's connection opens, so notifications bind to that runtime.
    @ObservationIgnored var beforeConnect: ((ClientModel, ConnectionTarget) async -> Void)?
    /// Runs once a removed machine's runtime has stopped, so nothing keeps routing to it.
    @ObservationIgnored var afterRemove: ((ClientModel, String) -> Void)?
    /// Runs once every listed machine has its runtime.
    @ObservationIgnored var afterLoad: (() -> Void)?

    init(access: any MachineAccess, storage: URL, defaults: UserDefaults = .standard, itemLimit: Int = 200,
         now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         makeClient: @escaping @MainActor () -> ClientModel) {
        self.access = access; self.storage = storage; self.defaults = defaults; self.itemLimit = itemLimit; self.makeClient = makeClient
        inbox = MachineInbox(defaults: defaults, now: now)
        grants = defaults.dictionary(forKey: Keys.grants) as? [String: [String]] ?? [:]
    }
    func entry(_ hostId: String) -> MachineEntry? { machines.first { $0.hostId == hostId } }
    /// The host chose a view-only grant for this phone; its commands will be refused.
    func isReadOnly(_ hostId: String) -> Bool {
        entry(hostId).map { !canOperate($0) } ?? false
    }
    private func canOperate(_ entry: MachineEntry) -> Bool { Grants(scopes: grants[entry.deviceId] ?? ["operate"]).canOperate }

    /// Connect every machine this phone knew at once, then read the directory and follow it: a
    /// machine it no longer lists stops, a changed one reconnects, a new one connects. Reading the
    /// directory starts a JavaScript runtime of its own, so a relaunch never waits on it before
    /// its machines start. An offline machine gates nothing.
    func load() async {
        let known = (defaults.data(forKey: Keys.known)).flatMap { try? JSONDecoder().decode([MachineEntry].self, from: $0) } ?? []
        if !known.isEmpty {
            machines = known
            loaded = true
            for entry in known { await connect(entry) }
        }
        let listing = LaunchTrace.begin("machines.list")
        let listed = await access.perform(.list)
        listing.end()
        switch listed {
        case .success(let outcome): await follow(outcome.machines ?? [])
        case .failure(let notice): problem = notice
        }
        loaded = true
        for entry in machines { await connect(entry) }
        afterLoad?()
    }
    /// How many machines the next launch will connect at once, before anything is read.
    nonisolated static func rememberedCount(in defaults: UserDefaults) -> Int {
        (defaults.data(forKey: Keys.known)).flatMap { try? JSONDecoder().decode([MachineEntry].self, from: $0) }?.count ?? 0
    }
    /// The directory's answer replaces what this phone remembered.
    private func follow(_ listed: [MachineEntry]) async {
        let previous = machines
        machines = listed
        for entry in previous {
            let current = listed.first { $0.hostId == entry.hostId }
            if current == entry { continue }
            if let current, current.target == entry.target, current.deviceId == entry.deviceId {
                inbox.rename(entry.hostId, to: current.displayName)
                continue
            }
            // Gone from the directory, or reachable another way now: this runtime stops.
            guard let client = inbox.detach(entry.hostId) else { continue }
            unsupported.remove(entry.hostId)
            await client.disconnectAndWait()
            afterRemove?(client, entry.hostId)
        }
    }
    /// Redeem a confirmed link, store the device, then connect it beside the others.
    func pair(_ link: PairingLink, name: String) async -> ProblemNotice? {
        switch await access.perform(.pair(link, name: name)) {
        case .failure(let notice): return notice
        case .success(let outcome):
            machines = outcome.machines ?? machines
            guard let paired = outcome.paired, let entry = entry(paired.hostId) else { return .unknown }
            grants[entry.deviceId] = paired.scopes
            defaults.set(grants, forKey: Keys.grants)
            await connect(entry)
            return nil
        }
    }
    /// A name for this phone only; the computer keeps its own.
    func rename(_ hostId: String, to name: String) async -> ProblemNotice? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        switch await access.perform(.rename(hostId: hostId, name: String(trimmed.prefix(256)))) {
        case .failure(let notice): return notice
        case .success(let outcome):
            machines = outcome.machines ?? machines
            if let entry = entry(hostId) { inbox.rename(hostId, to: entry.displayName) }
            return nil
        }
    }
    /// Stop that machine's runtime, remove its credential, then the local data bound to that host
    /// and device. The other machines keep running throughout.
    func remove(_ hostId: String) async {
        guard let entry = entry(hostId) else { return }
        let client = inbox.client(hostId)
        await client?.disconnectAndWait()
        switch await access.perform(.remove(hostId: hostId)) {
        case .failure(let notice):
            problem = notice
            if let client, let target = entry.connectionTarget { await open(client, entry: entry, target: target) }
            return
        case .success(let outcome): machines = outcome.machines ?? machines.filter { $0.hostId != hostId }
        }
        if let client = inbox.detach(hostId) { afterRemove?(client, hostId) }
        unsupported.remove(hostId)
        grants[entry.deviceId] = nil
        defaults.set(grants, forKey: Keys.grants)
        let database = ClientModel.database(hostId: entry.hostId, deviceId: entry.deviceId, in: storage)
        for suffix in ["", "-wal", "-shm", InboxCheckpoint.suffix] + ["", "-wal", "-shm"].map({ SnapshotStore.suffix + $0 }) { try? FileManager.default.removeItem(at: URL(fileURLWithPath: database.path + suffix)) }
    }
    /// Back from the background: a suspended socket may be dead without having closed, so every
    /// machine checks its own now instead of at its next heartbeat.
    func wake() { for session in inbox.sessions { session.client.wake() } }
    /// Network changes reach every runtime; the SDK owns each reconnect.
    func network(online: Bool, interfaceChanged: Bool) {
        for session in inbox.sessions {
            session.client.network(online)
            // A new interface (Wi-Fi, cellular, Tailscale) can reach a host the old one couldn't.
            if online && interfaceChanged { session.client.retry() }
        }
    }
    func disconnectAll() async {
        for session in inbox.sessions { await session.client.disconnectAndWait() }
    }
    private func connect(_ entry: MachineEntry) async {
        guard let target = entry.connectionTarget else { unsupported.insert(entry.hostId); return }
        if inbox.client(entry.hostId) != nil { return }
        let client = makeClient()
        inbox.attach(entry.hostId, name: entry.displayName, client: client)
        await open(client, entry: entry, target: target)
    }
    private func open(_ client: ClientModel, entry: MachineEntry, target: ConnectionTarget) async {
        client.canOperate = canOperate(entry)
        client.canAdmin = grants[entry.deviceId].map { Grants(scopes: $0).canAdmin }
        await beforeConnect?(client, target)
        await client.connect(target: target, directory: storage, itemLimit: itemLimit)
    }
    private nonisolated enum Keys { static let grants = "ace.machines.grants", known = "ace.machines.known" }
}
