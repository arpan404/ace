import Foundation
import Testing
@testable import Ace

/// The SDK directory and the VMs are substituted at their boundaries; model logic is real.
@Suite(.timeLimit(.minutes(1))) @MainActor struct MachinesModelTests {
    @Test func everyPairedMachineConnectsAtOnceEachBoundToItsOwnHostDeviceAndDatabase() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let started = fixture.sessions.started
        #expect(started.map(\.target.hostId) == ["studio", "laptop"])
        #expect(started.allSatisfy { $0.target.endpoint.scheme == "wss" && $0.target.pin == DaemonCertificate.pin })
        #expect(started.map(\.target.secretKey) == ["[\"studio\",\"phone-1\"]", "[\"laptop\",\"phone-2\"]"])
        #expect(started[0].storage == ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage))
        #expect(started[0].storage != started[1].storage)
        #expect(fixture.model.inbox.showsMachineNames)
    }

    @Test func oneMachineGoingOfflineLeavesTheOtherMachinesRowsAndStatusUntouched() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let (studio, laptop) = (fixture.sessions.started[0], fixture.sessions.started[1])
        // The same thread id on both machines: one waits on the person, one is done.
        studio.emit(patches(connection: "ready", row: ("t1", "needs-you", "Needs you", "needsYou"), rank: "1"))
        laptop.emit(patches(connection: "ready", row: ("t1", "done", "Done", "done"), rank: "2"))
        await drain()
        let inbox = fixture.model.inbox
        #expect(inbox.merged.sections.map(\.key) == ["needs-you", "done"])
        #expect(inbox.row(InboxKey(machineId: "studio", id: "t1"))?.status.label == "Needs you")
        #expect(inbox.row(InboxKey(machineId: "laptop", id: "t1"))?.status.label == "Done")

        // The laptop drops; its runtime reports its copy as unconfirmed. The studio is unaffected.
        laptop.emit(patches(connection: "reconnecting", row: ("t1", "syncing", "Syncing", "neutral"), rank: "2",
                            problem: #"{"code":"unreachable","message":"Can't reach"}"#))
        await drain()
        #expect(inbox.merged.sections.map { $0.rows } == [[InboxKey(machineId: "studio", id: "t1")], [InboxKey(machineId: "laptop", id: "t1")]])
        #expect(inbox.merged.sections.map(\.key) == ["needs-you", "syncing"])
        #expect(inbox.client("studio")?.connection == "ready")
        #expect(inbox.client("studio")?.problem == nil)
        #expect(inbox.client("laptop")?.problem?.code == "unreachable")
        #expect(!inbox.allReady)
    }

    @Test func aRowsCommandsGoOnlyToTheRuntimeOfItsMachine() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let key = InboxKey(machineId: "laptop", id: "t1")
        let archive = Task { await fixture.model.inbox.client(key.machineId)?.archive(key.id) }
        await drain()
        fixture.model.inbox.client("laptop")?.open(key.id)
        #expect(fixture.sessions.started[0].invoked.isEmpty)
        let sent = fixture.sessions.started[1].invoked.joined()
        #expect(sent.contains(#""kind":"archive""#) && sent.contains(#""threadId":"t1""#))
        #expect(sent.contains(#""type":"open""#))
        // Disconnecting cancels the pending admission; the fake VMs then finish shutting down.
        for session in fixture.model.inbox.sessions { session.client.disconnect() }
        for session in fixture.sessions.started { session.finishShutdown() }
        _ = await archive.value
    }

    @Test func comingBackFromTheBackgroundAsksEveryMachineToCheckItsSocketNow() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(fixture.sessions.started.allSatisfy { !$0.invoked.joined().contains(#""type":"wake""#) })
        fixture.model.wake()
        #expect(fixture.sessions.started.allSatisfy { $0.invoked.joined().contains(#""type":"wake""#) })
    }

    @Test func pairingConnectsTheNewMachineBesideTheOthersAndStoresItsGrant() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(!fixture.model.inbox.showsMachineNames)
        fixture.access.pairing = .success(machine("laptop", device: "phone-2"), scopes: ["read"])
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc&scopes=read")
        #expect(await fixture.model.pair(link, name: "Phone") == nil)
        #expect(fixture.sessions.started.map(\.target.hostId) == ["studio", "laptop"])
        #expect(fixture.sessions.started[0].stopped == false)
        #expect(fixture.model.isReadOnly("laptop"))
        #expect(!fixture.model.isReadOnly("studio"))
        #expect(fixture.model.inbox.showsMachineNames)
    }

    @Test func aViewOnlyMachineSubmitsNoCommandsWhileAMachineThatAllowsActingStillDoes() async throws {
        let fixture = try Fixture(machines: [machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        fixture.access.pairing = .success(machine("studio", device: "phone-1"), scopes: ["read"])
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc&scopes=read")
        #expect(await fixture.model.pair(link, name: "Phone") == nil)
        let client = try #require(fixture.model.inbox.client("studio"))
        let viewOnly = try #require(fixture.sessions.started.last)
        #expect(viewOnly.target.hostId == "studio")
        #expect(!client.canOperate)
        client.open("thread-1")
        let approval = ApprovalRow(id: "ask", kind: "approval", state: "pending", title: "Run a command", description: "", command: "git push",
                                   options: [.init(id: "allow", label: "Allow", kind: "allow_once")], truncated: false)
        #expect(await client.send("Ship it", delivery: "queue") == false)
        client.approve(approval, option: approval.options[0])
        client.stopTree()
        #expect(await client.archive("thread-1") == false)
        #expect(await client.snooze("thread-1", preset: "hour") == false)
        #expect(client.approvalSubmissions.isEmpty)
        #expect(viewOnly.submitted.isEmpty)
        // The machine paired with View and act keeps taking commands beside it.
        let laptop = try #require(fixture.model.inbox.client("laptop"))
        #expect(laptop.canOperate)
        laptop.open("thread-1")
        // Stop is offered only when the bridge's canonical controls say the tree can stop.
        let epoch = try #require(laptop.thread?.epoch)
        let controls: [[String: Any]] = [["type": "thread.controls", "threadId": "thread-1", "epoch": epoch,
                                          "row": ["busy": true, "delivery": "queue", "alternate": NSNull(), "canStop": true, "provider": "codex", "model": "", "switching": ""]]]
        laptop.receive(try JSONSerialization.data(withJSONObject: controls))
        laptop.stopTree()
        let operating = fixture.sessions.started[0]
        for _ in 0..<20 where operating.submitted.isEmpty { await Task.yield() }
        #expect(operating.submitted.count == 1)
    }

    @Test func notificationsBindToEachMachineBeforeItsRuntimeOpens() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        var bound: [(host: String, runtimesBefore: Int)] = []
        fixture.model.beforeConnect = { _, target in bound.append((target.hostId, fixture.sessions.started.count)) }
        await fixture.model.load()
        #expect(bound.map(\.host) == ["studio", "laptop"])
        #expect(bound.map(\.runtimesBefore) == [0, 1])
    }

    @Test func aRefusedPairingAddsNothingAndReportsWhy() async throws {
        let fixture = try Fixture(machines: [])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        fixture.access.pairing = .failure(ProblemNotice(code: "expired", message: "expired"))
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=used")
        #expect(await fixture.model.pair(link, name: "Phone")?.code == "expired")
        #expect(fixture.model.machines.isEmpty)
        #expect(fixture.sessions.started.isEmpty)
    }

    @Test func removingOneMachineStopsOnlyItsRuntimeThenDeletesItsCredentialAndDatabase() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let (studio, laptop) = (fixture.sessions.started[0], fixture.sessions.started[1])
        let database = ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage)
        try FileManager.default.createDirectory(at: fixture.storage, withIntermediateDirectories: true)
        try Data("outbox".utf8).write(to: database)
        try InboxCheckpoint.write("[]", database: database)
        let removal = Task { await fixture.model.remove("studio") }
        await drain()
        #expect(studio.stopped)
        #expect(fixture.access.removed.isEmpty) // Waits for the runtime that holds the database.
        studio.finishShutdown()
        await removal.value
        #expect(fixture.access.removed == ["studio"])
        #expect(!FileManager.default.fileExists(atPath: database.path))
        #expect(!FileManager.default.fileExists(atPath: InboxCheckpoint.url(database: database).path))
        #expect(fixture.model.machines.map(\.hostId) == ["laptop"])
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["laptop"])
        #expect(!laptop.stopped)
        #expect(fixture.sessions.started.count == 2) // Nothing reconnects or restarts.
        // Late facts from the removed runtime reach nothing.
        studio.emit(patches(connection: "ready", row: ("late", "done", "Done", "done"), rank: "1"))
        await drain()
        #expect(fixture.model.inbox.merged.sections.isEmpty)
    }

    @Test func aFailedRemovalKeepsTheMachineAndReconnectsIt() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        fixture.access.removal = .failure(ProblemNotice(code: "storage", message: "Keychain unavailable"))
        let removal = Task { await fixture.model.remove("studio") }
        await drain()
        fixture.sessions.started[0].finishShutdown()
        await removal.value
        #expect(fixture.model.problem?.code == "storage")
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
        #expect(fixture.sessions.started.count == 2)
        #expect(fixture.sessions.started[1].target.hostId == "studio")
    }

    @Test func renamingAMachineRenamesItsRowsLabelOnThisPhone() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(await fixture.model.rename("studio", to: "  Desk  ") == nil)
        #expect(fixture.access.renamed == ["Desk"])
        #expect(fixture.model.inbox.name("studio") == "Desk")
        #expect(fixture.model.entry("studio")?.displayName == "Desk")
    }

    @Test func lastSeenIsNowWhileConnectedAndSurvivesARelaunchOnceRecorded() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let studio = fixture.sessions.started[0]
        studio.emit(#"[{"type":"connection","state":"ready"}]"#)
        await drain()
        #expect(fixture.model.inbox.lastSeen("studio") == 5_000)
        studio.emit(#"[{"type":"connection","state":"reconnecting"},{"type":"machine.status","status":{"label":"Can't reach","token":"neutral"},"seenAt":4000}]"#)
        await drain()
        #expect(fixture.model.inbox.lastSeen("studio") == 4_000)
        fixture.model.inbox.recordSeen()
        let relaunched = MachineInbox(defaults: fixture.defaults, now: { 9_000 })
        #expect(relaunched.lastSeen("studio") == 4_000)
    }

    @Test func aRelaunchConnectsTheMachinesItKnewBeforeTheDirectoryAnswers() async throws {
        let first = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { first.cleanUp() }
        await first.model.load()
        // The next launch: the directory's own runtime has not answered yet.
        let relaunch = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")], defaults: first.defaults)
        relaunch.access.holdList()
        let loading = Task { await relaunch.model.load() }
        for _ in 0..<50 where relaunch.sessions.started.count < 2 { await Task.yield() }
        #expect(relaunch.model.loaded)
        #expect(relaunch.sessions.started.map(\.target.hostId) == ["studio", "laptop"])
        relaunch.access.releaseList()
        await loading.value
        // The directory agreed: nothing restarts.
        #expect(relaunch.sessions.started.count == 2)
        #expect(relaunch.sessions.started.allSatisfy { !$0.stopped })
    }

    @Test func aMachineTheDirectoryNoLongerListsStopsAfterARelaunchAndANewOneConnects() async throws {
        let first = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { first.cleanUp() }
        await first.model.load()
        let relaunch = try Fixture(machines: [machine("studio", device: "phone-1"), machine("desk", device: "phone-3")], defaults: first.defaults)
        var removed: [String] = []
        relaunch.model.afterRemove = { _, host in removed.append(host) }
        let loading = Task { await relaunch.model.load() }
        for _ in 0..<50 where relaunch.sessions.started.count < 2 { await Task.yield() }
        let laptop = try #require(relaunch.sessions.started.first { $0.target.hostId == "laptop" })
        for _ in 0..<50 where !laptop.stopped { await Task.yield() }
        laptop.finishShutdown()
        await loading.value
        #expect(removed == ["laptop"])
        #expect(relaunch.model.inbox.sessions.map(\.hostId) == ["studio", "desk"])
        #expect(relaunch.model.machines.map(\.hostId) == ["studio", "desk"])
    }

    private func machine(_ host: String, device: String) -> MachineEntry {
        MachineEntry(hostId: host, displayName: host.capitalized, icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: device)
    }
    private func drain() async { for _ in 0..<20 { await Task.yield() } }
    /// A runtime's connection, one inbox row with the shared status, and its section and rank.
    private func patches(connection: String, row: (id: String, section: String, label: String, token: String), rank: String,
                         problem: String = "null") -> String {
        let thread = #"{"id":"\#(row.id)","title":"Thread","state":"done","project":"ace","branch":"","machine":"","provider":"codex","model":"","agents":1,"updatedAt":1,"canSteer":false,"status":{"label":"\#(row.label)","token":"\#(row.token)"}}"#
        return #"[{"type":"connection","state":"\#(connection)"},{"type":"connection.problem","problem":\#(problem)},{"type":"inbox.reset"},{"type":"inbox.row","id":"\#(row.id)","row":\#(thread)},{"type":"inbox.sections","sections":[{"key":"\#(row.section)","label":"\#(row.label)","ids":["\#(row.id)"],"ranks":["\#(rank)"],"order":0}],"more":false,"snooze":[]}]"#
    }
}

@MainActor private struct Fixture {
    let sessions = FakeSessions()
    let access: FakeAccess
    let storage: URL
    let defaults: UserDefaults
    let suite: String
    let model: MachinesModel
    /// `defaults` from an earlier fixture plays the same phone relaunched.
    init(machines: [MachineEntry], defaults shared: UserDefaults? = nil) throws {
        access = FakeAccess(machines)
        storage = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "ace.tests.\(UUID().uuidString)"
        defaults = try shared ?? #require(UserDefaults(suiteName: suite))
        let sessions = self.sessions
        model = MachinesModel(access: access, storage: storage, defaults: defaults, now: { 5_000 },
                              makeClient: { ClientModel(now: { 0 }, makeRuntime: sessions.make) })
    }
    func cleanUp() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: storage)
    }
}

private final class FakeAccess: MachineAccess, @unchecked Sendable {
    enum Pairing { case success(MachineEntry, scopes: [String]), failure(ProblemNotice) }
    private let lock = NSLock()
    private var machines: [MachineEntry]
    var pairing: Pairing = .failure(.unknown)
    var removal: Result<Void, ProblemNotice> = .success(())
    private(set) var removed: [String] = []
    private(set) var renamed: [String] = []
    private let listGate = Gate()
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
            case .pair:
                switch pairing {
                case .failure(let notice): return .failure(notice)
                case .success(let entry, let scopes):
                    machines.append(entry)
                    return .success(AccessOutcome(ok: true, machines: machines, paired: .init(hostId: entry.hostId, scopes: scopes), problem: nil))
                }
            }
        }
    }
}

private final class Gate: @unchecked Sendable {
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

@MainActor private final class FakeSessions {
    var started: [FakeSession] = []
    func make(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
              _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let session = FakeSession(target: target, storage: storage, receive: receive)
        started.append(session)
        return session
    }
}
private final class FakeSession: ClientSession, @unchecked Sendable {
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
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopRequested = true; self.completion = completion } }
    func finishShutdown() { let done = lock.withLock { let value = completion; completion = nil; return value }; done?() }
    func emit(_ json: String) { receive(Data(json.utf8)) }
}
