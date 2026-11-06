import Foundation
import Observation

/// Paired computers and the machines on the phone's ace account, each connected at once on its
/// own runtime. Directory rules and credentials stay in the shared SDK and Keychain; account
/// machines come from the account backend. This model starts, renames and retires runtimes.
@MainActor @Observable final class MachinesModel {
    /// Remembered on every change, so the next launch connects them before the directory answers.
    private(set) var machines: [MachineEntry] = [] {
        didSet { if machines != oldValue { defaults.set(try? JSONEncoder().encode(machines), forKey: Keys.known) } }
    }
    private(set) var loaded = false
    /// What each pairing lets this phone do, by machine and device (`GrantBook`).
    private(set) var grants: GrantBook
    /// Directory trouble, or an operation on a machine that failed (for a person).
    var problem: ProblemNotice?
    /// Machines stored without a pinned direct address; they need pairing again.
    private(set) var unsupported: Set<String> = []
    /// Machines on the phone's ace account, as the backend last listed them (paired ones too).
    private(set) var accountMachines: [AceMachine] = []
    /// Signed in to an ace account with a listing this launch.
    private(set) var accountSignedIn = false
    /// Machines turned off on this phone (by the host id the list keys them by): listed, but no
    /// runtime, no rows, no notifications. Never told to the machine.
    private(set) var off: Set<String>
    /// The route each machine reachable two ways is on (`MachineRoutePlan`), by host id.
    private(set) var plans: [String: MachineRoutePlan] = [:]
    let inbox: MachineInbox
    /// The SDK directory's paired machines; `machines` is these plus unpaired account machines.
    @ObservationIgnored private var paired: [MachineEntry] = []
    @ObservationIgnored private let access: any MachineAccess
    @ObservationIgnored private let account: (any AccountDirectory)?
    @ObservationIgnored private let storage: URL
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let itemLimit: Int
    @ObservationIgnored private let makeClient: @MainActor () -> ClientModel
    /// This app install (ADR 0115), in every hello.
    @ObservationIgnored private let installId: String?
    @ObservationIgnored private let probe: (ConnectionTarget) async -> Bool
    /// Milliseconds, for the route plans' hold and cooldown.
    @ObservationIgnored private let clock: () -> Double
    /// Account machines whose daemon said, over the relay, which paired machine it is: account
    /// host id → daemon id.
    @ObservationIgnored private var daemons: [String: String]
    /// Each machine's latest open, by host id: an open that waited (on notifications binding)
    /// goes on only if no later open, turn-off or removal came meanwhile.
    @ObservationIgnored private var openings: [String: Int] = [:]
    /// A look at a machine's route its plan asked for later (`MachineRoutePlan`).
    @ObservationIgnored private var retries: RouteRetries
    /// Runs before each machine's connection opens, so notifications bind to that runtime.
    @ObservationIgnored var beforeConnect: ((ClientModel, ConnectionTarget) async -> Void)?
    /// Runs once a removed machine's runtime has stopped, so nothing keeps routing to it.
    @ObservationIgnored var afterRemove: ((ClientModel, String) -> Void)?
    /// Runs once every listed machine has its runtime.
    @ObservationIgnored var afterLoad: (() -> Void)?
    /// Runs once a machine turned off here has let its runtime go, so what it showed outside the
    /// app (notifications, the Live Activity, widgets) goes too.
    @ObservationIgnored var afterTurnOff: ((String) -> Void)?

    init(access: any MachineAccess, account: (any AccountDirectory)? = nil, storage: URL, defaults: UserDefaults = .standard,
         itemLimit: Int = 200, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, installId: String? = nil,
         probe: @escaping (ConnectionTarget) async -> Bool = DirectProbe.answers,
         schedule: @escaping RouteScheduler = RouteRetries.sleeping,
         makeClient: @escaping @MainActor () -> ClientModel) {
        self.access = access; self.account = account; self.storage = storage; self.defaults = defaults; self.itemLimit = itemLimit; self.makeClient = makeClient
        self.installId = installId; self.probe = probe; clock = now
        retries = RouteRetries(schedule: schedule)
        inbox = MachineInbox(defaults: defaults, now: now)
        grants = GrantBook(defaults.dictionary(forKey: Keys.grants) as? [String: [String]] ?? [:])
        off = Self.turnedOff(in: defaults)
        daemons = defaults.dictionary(forKey: Keys.daemons) as? [String: String] ?? [:]
    }
    func entry(_ hostId: String) -> MachineEntry? { machines.first { $0.hostId == hostId } }
    /// The host chose a view-only grant for this phone; its commands will be refused.
    func isReadOnly(_ hostId: String) -> Bool {
        entry(hostId).map { !canOperate($0) } ?? false
    }
    private func canOperate(_ entry: MachineEntry) -> Bool { Grants(scopes: grants.scopes(for: entry) ?? ["operate"]).canOperate }
    private func saveGrants() { defaults.set(grants.saved, forKey: Keys.grants) }

    /// Connect every machine this phone knew at once, then read the directory and follow it: a
    /// machine it no longer lists stops, a changed one reconnects, a new one connects. Reading the
    /// directory starts a JavaScript runtime of its own, so a relaunch never waits on it before
    /// its machines start. An offline machine gates nothing.
    func load() async {
        let known = (defaults.data(forKey: Keys.known)).flatMap { try? JSONDecoder().decode([MachineEntry].self, from: $0) } ?? []
        if !known.isEmpty {
            machines = known
            paired = known.filter { !$0.isAccountMachine }
            // A paired machine also on the account keeps its relay route before the account answers.
            accountMachines = known.compactMap { entry in
                (entry.isAccountMachine ? entry.hostId : entry.accountHostId).map { AceMachine(hostId: $0, name: entry.displayName, platform: "", lastSeenAt: 0) }
            }
            loaded = true
            for entry in known { await connect(entry) }
        }
        let listing = LaunchTrace.begin("machines.list")
        async let accountListing = listAccount()
        let listed = await access.perform(.list)
        listing.end()
        switch listed {
        case .success(let outcome): paired = outcome.machines ?? []
        case .failure(let notice): problem = notice
        }
        await adopt(account: await accountListing)
        // Grants saved by device alone move to their machine, now that the machines are known.
        if grants.adopt(paired) { saveGrants() }
        loaded = true
        for entry in machines { await connect(entry) }
        afterLoad?()
    }
    /// How many machines the next launch will connect at once, before anything is read.
    nonisolated static func rememberedCount(in defaults: UserDefaults) -> Int {
        (defaults.data(forKey: Keys.known)).flatMap { try? JSONDecoder().decode([MachineEntry].self, from: $0) }?.count ?? 0
    }
    /// Read the account's machines again (after sign-in, sign-out or on request) and follow them.
    func refreshAccount() async {
        await adopt(account: await listAccount())
        for entry in machines { await connect(entry) }
    }
    /// The account's machines, or why there are none to follow.
    private func listAccount() async -> AccountListing {
        guard let account else { return .signedOut }
        do { return try await account.machines().map(AccountListing.listed) ?? .signedOut }
        catch { return .unavailable }
    }
    private enum AccountListing { case listed([AceMachine]), signedOut, unavailable }
    private func adopt(account listing: AccountListing) async {
        switch listing {
        case .listed(let listed): accountMachines = listed; accountSignedIn = true
        case .signedOut: accountMachines = []; accountSignedIn = false
        case .unavailable: break
        }
        await follow(merged())
    }
    private func merged() -> [MachineEntry] {
        guard let account, let relay = account.relayURL?.absoluteString else { return paired }
        return AccountMachines.merge(paired: paired, account: accountMachines, relayURL: relay, deviceId: account.deviceId, daemons: daemons)
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
            dropPlan(entry.hostId)
            supersedeOpening(entry.hostId)
            guard let client = inbox.detach(entry.hostId) else { continue }
            unsupported.remove(entry.hostId)
            await client.disconnectAndWait()
            afterRemove?(client, entry.hostId)
        }
        await followOff()
        // A machine that gained or lost its account route keeps its runtime, on a route it still has.
        for entry in listed where plans[entry.hostId] != nil {
            let routes = targets(for: entry)
            await take(plans[entry.hostId]?.routes(direct: routes.direct != nil, relay: routes.relay != nil, at: clock()), entry.hostId)
        }
    }
    /// Redeem a confirmed link, store the device, then connect it beside the others.
    func pair(_ link: PairingLink, name: String) async -> ProblemNotice? {
        switch await access.perform(.pair(link, name: name)) {
        case .failure(let notice): return notice
        case .success(let outcome):
            // Through `follow`: an account machine this pairing turns out to be lets its runtime go.
            if let listed = outcome.machines { paired = listed; await follow(merged()) }
            guard let paired = outcome.paired, let entry = entry(paired.hostId) else { return .unknown }
            grants.set(paired.scopes, for: entry)
            saveGrants()
            // Paired again while connected: the daemon closed the old credential's sockets, so the
            // runtime opens again with the new credential and grants.
            if let client = inbox.client(entry.hostId) {
                if let target = target(for: entry) { await open(client, entry: entry, target: target) }
            } else {
                await connect(entry)
            }
            return nil
        }
    }
    /// A name for this phone only; the computer keeps its own.
    func rename(_ hostId: String, to name: String) async -> ProblemNotice? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if entry(hostId)?.isAccountMachine == true {
            return ProblemNotice(code: "account", message: "This machine's name comes from your ace account. Rename it on the machine.")
        }
        switch await access.perform(.rename(hostId: hostId, name: String(trimmed.prefix(256)))) {
        case .failure(let notice): return notice
        case .success(let outcome):
            if let listed = outcome.machines { paired = listed; await follow(merged()) }
            if let entry = entry(hostId) { inbox.rename(hostId, to: entry.displayName) }
            return nil
        }
    }
    /// Stop that machine's runtime, remove its credential, then the local data bound to that host
    /// and device. The other machines keep running throughout.
    func remove(_ hostId: String) async {
        guard let entry = entry(hostId) else { return }
        let known = aliases(of: hostId)
        let client = inbox.client(hostId)
        supersedeOpening(hostId)
        await client?.disconnectAndWait()
        if let notice = await forgetOrUnpair(entry) {
            problem = notice
            if let client, let target = target(for: entry) { await open(client, entry: entry, target: target) }
            return
        }
        dropPlan(hostId)
        if let client = inbox.detach(hostId) { afterRemove?(client, hostId) }
        if !off.isDisjoint(with: known) { off.subtract(known); saveOff() }
        // Removed on purpose: what this phone remembers of the machine goes too. A machine that
        // only left the list (signed out, another account) keeps it for when it comes back.
        inbox.forget(hostId)
        unsupported.remove(hostId)
        grants.set(nil, for: entry)
        saveGrants()
        let database = ClientModel.database(hostId: entry.hostId, deviceId: entry.deviceId, in: storage)
        for suffix in ["", "-wal", "-shm", InboxCheckpoint.suffix] + ["", "-wal", "-shm"].map({ SnapshotStore.suffix + $0 }) { try? FileManager.default.removeItem(at: URL(fileURLWithPath: database.path + suffix)) }
    }
    /// Take a machine off the ace account's list (from Profile). One reached through the account
    /// stops and loses its local data; a paired one stays paired.
    func forgetAccountMachine(_ hostId: String) async -> ProblemNotice? {
        if entry(hostId)?.isAccountMachine == true {
            problem = nil
            await remove(hostId)
            return problem
        }
        do { try await account?.forget(hostId) }
        catch { return ProblemNotice(code: "account", message: "Couldn't forget this machine. Check your connection and try again.") }
        accountMachines.removeAll { $0.hostId == hostId }
        return nil
    }
    /// Back from the background: a suspended socket may be dead without having closed, so every
    /// machine checks its own now instead of at its next heartbeat.
    /// A machine on its account relay checks whether its direct address answers again.
    func wake() {
        for session in inbox.sessions { session.client.wake() }
        reconsiderRoutes()
    }
    /// Network changes reach every runtime; the SDK owns each reconnect, and a machine on its
    /// account relay checks whether its direct address answers on the new network.
    func network(online: Bool, interfaceChanged: Bool) {
        for session in inbox.sessions {
            session.client.network(online)
            // A new interface (Wi-Fi, cellular, Tailscale) can reach a host the old one couldn't.
            if online && interfaceChanged { session.client.retry() }
        }
        if online && interfaceChanged { reconsiderRoutes() }
    }
    func disconnectAll() async {
        for session in inbox.sessions { await session.client.disconnectAndWait() }
    }
    /// An account machine leaves the account's list (it returns if it signs in again); a paired
    /// one loses its device token. Nil when done.
    private func forgetOrUnpair(_ entry: MachineEntry) async -> ProblemNotice? {
        if entry.isAccountMachine {
            do { try await account?.forget(entry.hostId) }
            catch { return ProblemNotice(code: "account", message: "Couldn't forget this machine. Check your connection and try again.") }
            accountMachines.removeAll { $0.hostId == entry.hostId }
            await follow(merged())
            return nil
        }
        switch await access.perform(.remove(hostId: entry.hostId)) {
        case .failure(let notice): return notice
        case .success(let outcome):
            paired = outcome.machines ?? paired.filter { $0.hostId != entry.hostId }
            // Also on the account: it comes back with the next account listing, through the relay.
            await follow(merged().filter { $0.hostId != entry.hostId })
            return nil
        }
    }
    /// The routes a machine has: pinned direct for a paired machine, the account relay for an
    /// account machine, and both for a paired machine also on the account. Every route keeps the
    /// machine's own scope, so either one reads and writes the same cache.
    private func targets(for entry: MachineEntry) -> (direct: ConnectionTarget?, relay: ConnectionTarget?) {
        let scope = MachineScope(hostId: entry.hostId, deviceId: entry.deviceId)
        var direct = entry.isAccountMachine ? nil : entry.connectionTarget
        let relayHost = entry.isAccountMachine ? entry.hostId : entry.accountHostId
        var relay = relayHost.flatMap { host in
            account?.route(hostId: host).map { ConnectionTarget(relay: $0, deviceId: entry.isAccountMachine ? entry.deviceId : account?.deviceId ?? entry.deviceId) }
        }
        direct?.installId = installId
        relay?.installId = installId
        relay?.machineScope = scope
        // One machine reached both ways is one device under two ids: what either route saved is
        // the other's too (ADR 0115).
        if let pairedId = direct?.deviceId, let accountId = relay?.deviceId, pairedId != accountId {
            direct?.deviceAliases = [accountId]
            relay?.deviceAliases = [pairedId]
        }
        return (direct, relay)
    }
    /// The route the machine's plan is on, or the one it has.
    private func target(for entry: MachineEntry) -> ConnectionTarget? {
        let routes = targets(for: entry)
        return plans[entry.hostId]?.current == .relay ? routes.relay ?? routes.direct : routes.direct ?? routes.relay
    }
    private func connect(_ entry: MachineEntry) async {
        let routes = targets(for: entry)
        guard routes.direct != nil || routes.relay != nil else { unsupported.insert(entry.hostId); return }
        if isOff(entry.hostId) || inbox.client(entry.hostId) != nil { return }
        plans[entry.hostId] = MachineRoutePlan(direct: routes.direct != nil, relay: routes.relay != nil)
        guard let target = target(for: entry) else { return }
        let client = makeClient()
        let hostId = entry.hostId
        client.onConnection = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                await self.take(self.plans[hostId]?.connection(state, at: self.clock()), hostId)
            }
        }
        client.onMachineIdentity = { [weak self] identity in Task { @MainActor in await self?.learned(identity, from: hostId) } }
        inbox.attach(entry.hostId, name: entry.displayName, client: client)
        await open(client, entry: entry, target: target)
    }
    /// Does what a machine's route plan said: reopen its runtime on the other route, or probe the
    /// direct address and report the answer back to the plan.
    private func take(_ step: MachineRoutePlan.Step?, _ hostId: String) async {
        guard let step, let entry = entry(hostId), let client = inbox.client(hostId) else { return }
        switch step {
        case .stay: return
        case .open:
            retries.cancel(hostId)
            if let target = target(for: entry) { await open(client, entry: entry, target: target) }
        case .reconsider(let at):
            retries.set(hostId, after: at - clock()) { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    await self.take(self.plans[hostId]?.networkChanged(at: self.clock()), hostId)
                }
            }
        case .probeDirect:
            var answered = false
            if let direct = targets(for: entry).direct { answered = await probe(direct) }
            guard inbox.client(hostId) === client else { return }
            await take(plans[hostId]?.probed(answered: answered, at: clock()), hostId)
        }
    }
    /// The machine's route plan ends, and any look at its route it asked for later with it.
    private func dropPlan(_ hostId: String) {
        plans[hostId] = nil
        retries.cancel(hostId)
    }
    private func reconsiderRoutes() {
        for hostId in plans.keys where plans[hostId]?.current == .relay {
            Task { await take(plans[hostId]?.networkChanged(at: clock()), hostId) }
        }
    }
    /// What a machine said about itself over its own authenticated connection: a paired
    /// machine's paths are saved with it (they may name its account machine), and an account
    /// machine whose daemon is a paired machine becomes that machine (ADR 0115).
    private func learned(_ identity: MachineIdentityPatch, from hostId: String) async {
        guard let entry = entry(hostId), let daemon = identity.hostId else { return }
        if entry.isAccountMachine {
            guard daemon != hostId, daemons[hostId] != daemon, paired.contains(where: { $0.hostId == daemon }) else { return }
            daemons[hostId] = daemon
            defaults.set(daemons, forKey: Keys.daemons)
            await follow(merged())
            return
        }
        guard daemon == hostId, let paths = identity.paths, paths != paired.first(where: { $0.hostId == hostId })?.paths ?? [] else { return }
        if case .success(let outcome) = await access.perform(.remember(hostId: hostId, paths: paths)), let listed = outcome.machines {
            paired = listed
            await follow(merged())
        }
    }

    // MARK: Turning a machine off on this phone

    /// Off under any id this phone knows the machine by: turned off as an account machine, it
    /// stays off once it is known to be a paired one, and the other way round.
    func isOff(_ hostId: String) -> Bool { !off.isDisjoint(with: aliases(of: hostId)) }
    /// Every id this phone knows one machine by: its listing id, the account machine a paired
    /// entry took in, and the paired machine an account machine's daemon said it is.
    private func aliases(of hostId: String) -> Set<String> {
        var ids: Set<String> = [hostId]
        for entry in machines where entry.hostId == hostId || entry.accountHostId == hostId {
            ids.insert(entry.hostId)
            if let account = entry.accountHostId { ids.insert(account) }
        }
        if let daemon = daemons[hostId] { ids.insert(daemon) }
        for (account, daemon) in daemons where daemon == hostId { ids.insert(account) }
        return ids
    }
    /// Off: the machine stays listed and paired, with its credential, grants and cache, but its
    /// runtime stops and its threads, notifications and lock screen rows go. On: it connects
    /// again with the same identity. Kept on this phone only; the machine is never told.
    func setOn(_ hostId: String, _ on: Bool) async {
        let ids = aliases(of: hostId)
        if on {
            guard !off.isDisjoint(with: ids) else { return }
            off.subtract(ids)
            saveOff()
            if let entry = entry(hostId) { await connect(entry) }
            return
        }
        guard !ids.isSubset(of: off) else { return }
        off.formUnion(ids)
        saveOff()
        await stopTurnedOff(hostId, ids)
    }
    /// A machine turned off lets its runtime go, and what it showed outside the app under any
    /// of its ids goes too.
    private func stopTurnedOff(_ hostId: String, _ ids: Set<String>) async {
        dropPlan(hostId)
        supersedeOpening(hostId)
        if let client = inbox.detach(hostId) {
            await client.disconnectAndWait()
            afterRemove?(client, hostId)
        }
        for id in ids.sorted() { afterTurnOff?(id) }
    }
    /// The list learned that two ids are one machine: if either was turned off, the machine is
    /// off under both, and a runtime it still has stops.
    private func followOff() async {
        for entry in machines {
            let ids = aliases(of: entry.hostId)
            guard !off.isDisjoint(with: ids) else { continue }
            if !ids.isSubset(of: off) { off.formUnion(ids); saveOff() }
            if inbox.client(entry.hostId) != nil { await stopTurnedOff(entry.hostId, ids) }
        }
    }
    private func saveOff() { defaults.set(off.sorted(), forKey: Keys.off) }
    /// The machines turned off on this phone, as stored; notifications read it too.
    nonisolated static func turnedOff(in defaults: UserDefaults) -> Set<String> {
        Set(defaults.stringArray(forKey: Keys.off) ?? [])
    }
    /// Binds notifications, then connects, unless while they bound the machine was turned off,
    /// removed, given another runtime or opened again: then the later change stands.
    private func open(_ client: ClientModel, entry: MachineEntry, target: ConnectionTarget) async {
        let hostId = entry.hostId
        let opening = supersedeOpening(hostId)
        client.canOperate = canOperate(entry)
        client.canAdmin = grants.scopes(for: entry).map { Grants(scopes: $0).canAdmin }
        await beforeConnect?(client, target)
        guard openings[hostId] == opening, inbox.client(hostId) === client, !isOff(hostId) else { return }
        await client.connect(target: target, directory: storage, itemLimit: itemLimit)
    }
    /// Any open of this machine still waiting goes no further. Returns the new latest.
    @discardableResult private func supersedeOpening(_ hostId: String) -> Int {
        let next = (openings[hostId] ?? 0) &+ 1
        openings[hostId] = next
        return next
    }
    private nonisolated enum Keys {
        static let grants = "ace.machines.grants", known = "ace.machines.known"
        static let off = "ace.machines.off", daemons = "ace.machines.accountDaemons"
    }
}
