import Foundation
import Testing
@testable import Ace

// The SDK directory, the account backend and the VMs, substituted at their boundaries for the
// machine list's tests; the model's own logic stays real.

@MainActor struct MachinesFixture {
    let sessions = FakeMachineSessions()
    let access: FakeMachineAccess
    let storage: URL
    let defaults: UserDefaults
    let suite: String
    let model: MachinesModel
    /// The model's clock (ms), moved by the test.
    let clock = TestClock()
    /// The model's scheduler for later looks at a route; nothing runs until the test moves it.
    let scheduler: FakeScheduler
    /// `defaults` (and `storage`) from an earlier fixture plays the same phone relaunched.
    init(machines: [MachineEntry], account: (any AccountDirectory)? = nil, defaults shared: UserDefaults? = nil,
         storage sharedStorage: URL? = nil, probe: @escaping (ConnectionTarget) async -> Bool = { _ in false },
         moveSends: @escaping SendAdoptions.Move = SendAdoptions.durable) throws {
        access = FakeMachineAccess(machines)
        storage = sharedStorage ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "ace.tests.\(UUID().uuidString)"
        defaults = try shared ?? #require(UserDefaults(suiteName: suite))
        let sessions = self.sessions
        let clock = self.clock
        let scheduler = FakeScheduler(clock: clock)
        self.scheduler = scheduler
        model = MachinesModel(access: access, account: account, storage: storage, defaults: defaults, now: { clock.now },
                              installId: "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b", probe: probe,
                              schedule: { scheduler.schedule($0, $1) }, moveSends: moveSends,
                              makeClient: { ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make) })
    }
    func cleanUp() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: storage)
    }
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 5_000
    var now: Double { lock.withLock { value } }
    func advance(_ ms: Double) { lock.withLock { value += ms } }
}

/// Work scheduled for later, run only when the test moves the clock past it.
@MainActor final class FakeScheduler {
    private let clock: TestClock
    private var jobs: [(id: Int, at: Double, work: @MainActor () -> Void)] = []
    private var issued = 0
    init(clock: TestClock) { self.clock = clock }
    var pending: Int { jobs.count }
    func schedule(_ delay: Double, _ work: @escaping @MainActor () -> Void) -> @MainActor () -> Void {
        issued += 1
        let id = issued
        jobs.append((id, clock.now + delay, work))
        return { [weak self] in self?.jobs.removeAll { $0.id == id } }
    }
    /// Moves the clock and runs what has come due.
    func advance(_ ms: Double) {
        clock.advance(ms)
        let due = jobs.filter { $0.at <= clock.now }
        jobs.removeAll { $0.at <= clock.now }
        for job in due { job.work() }
    }
}

final class FakeAccountDirectory: AccountDirectory, @unchecked Sendable {
    private let lock = NSLock()
    private var listed: [AceMachine]?
    private(set) var forgotten: [String] = []
    init(_ machines: [AceMachine], deviceId: String = "ios-account-device") { listed = machines; self.deviceId = deviceId }
    let deviceId: String
    let relayURL: URL? = URL(string: "wss://ace.example.com")
    func signOut() { lock.withLock { listed = nil } }
    /// The account lists these machines from now on.
    func list(_ machines: [AceMachine]) { lock.withLock { listed = machines } }
    func machines() async throws(AccountGrantError) -> [AceMachine]? { lock.withLock { listed } }
    func forget(_ hostId: String) async throws(AccountGrantError) {
        lock.withLock { forgotten.append(hostId); listed?.removeAll { $0.hostId == hostId } }
    }
    func route(hostId: String) -> RelayRoute? {
        relayURL.map { RelayRoute(relayURL: $0, hostId: hostId, grants: AccountGrants { () async throws(AccountGrantError) -> AceGrant in throw .signedOut }) }
    }
}

final class FakeMachineAccess: MachineAccess, @unchecked Sendable {
    enum Pairing { case success(MachineEntry, scopes: [String]), failure(ProblemNotice) }
    private let lock = NSLock()
    private var machines: [MachineEntry]
    var pairing: Pairing = .failure(.unknown)
    var removal: Result<Void, ProblemNotice> = .success(())
    private(set) var removed: [String] = []
    private(set) var renamed: [String] = []
    private(set) var remembered: [String] = []
    private let listGate = ListGate()
    init(_ machines: [MachineEntry]) { self.machines = machines }
    /// The directory's runtime answers only once released.
    func holdList() { listGate.close() }
    func releaseList() { listGate.open() }
    func perform(_ request: AccessRequest) async -> Result<AccessOutcome, ProblemNotice> {
        if case .list = request { await listGate.wait() }
        return lock.withLock {
            switch request {
            case .list: return .success(AccessOutcome(ok: true, machines: machines, paired: nil, problem: nil))
            case .remove(let host):
                if case .failure(let notice) = removal { return .failure(notice) }
                removed.append(host)
                machines.removeAll { $0.hostId == host }
                return .success(AccessOutcome(ok: true, machines: machines, paired: nil, problem: nil))
            case .rename(let host, let name):
                renamed.append(name)
                machines = machines.map { $0.hostId == host ? MachineEntry(hostId: $0.hostId, displayName: name, icon: $0.icon, target: $0.target, deviceId: $0.deviceId) : $0 }
                return .success(AccessOutcome(ok: true, machines: machines, paired: nil, problem: nil))
            case .remember(let host, let paths):
                remembered.append(host)
                machines = machines.map { entry in
                    guard entry.hostId == host else { return entry }
                    var next = entry
                    next.paths = paths
                    return next
                }
                return .success(AccessOutcome(ok: true, machines: machines, paired: nil, problem: nil))
            case .pair:
                switch pairing {
                case .failure(let notice): return .failure(notice)
                case .success(let entry, let scopes):
                    // Pairing a machine again replaces its entry, as the SDK directory does.
                    machines.removeAll { $0.hostId == entry.hostId }
                    machines.append(entry)
                    return .success(AccessOutcome(ok: true, machines: machines, paired: .init(hostId: entry.hostId, scopes: scopes), problem: nil))
                }
            }
        }
    }
}

final class ListGate: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func close() { lock.withLock { closed = true } }
    func open() {
        let resumed = lock.withLock { closed = false; let all = waiters; waiters = []; return all }
        for waiter in resumed { waiter.resume() }
    }
    func wait() async {
        await withCheckedContinuation { continuation in
            let ready = lock.withLock { if closed { waiters.append(continuation); return false }; return true }
            if ready { continuation.resume() }
        }
    }
}

@MainActor final class FakeMachineSessions {
    var started: [FakeMachineSession] = []
    func make(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
              _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let session = FakeMachineSession(target: target, storage: storage, receive: receive)
        started.append(session)
        return session
    }
}
final class FakeMachineSession: ClientSession, @unchecked Sendable {
    let target: ConnectionTarget
    let storage: URL
    private let receive: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var completion: (@Sendable () -> Void)?
    private var stopRequested = false
    private var calls: [String] = []
    init(target: ConnectionTarget, storage: URL, receive: @escaping @Sendable (Data) -> Void) {
        self.target = target; self.storage = storage; self.receive = receive
    }
    var stopped: Bool { lock.withLock { stopRequested } }
    var invoked: [String] { lock.withLock { calls } }
    func start(itemLimit: Int) {}
    /// Commands and inbox organization the model handed to the VM.
    var submitted: [String] { lock.withLock { calls.filter { $0.contains("\"type\":\"command\"") || $0.contains("\"type\":\"inbox\"") || $0.contains("\"type\":\"thread\"") } } }
    func invoke(_ name: String, json: String) { lock.withLock { calls.append(json) } }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) {
        let now = lock.withLock { stopRequested = true; if autoFinish { return true }; self.completion = completion; return false }
        if now { completion() }
    }
    func finishShutdown() { let done = lock.withLock { let value = completion; completion = nil; return value }; done?() }
    /// Every later stop finishes at once, as a VM that shuts down promptly.
    func finishShutdownWhenStopped() { lock.withLock { autoFinish = true } }
    private var autoFinish = false
    func emit(_ json: String) { receive(Data(json.utf8)) }
}
