import Foundation
import Testing
@testable import Ace

/// The SDK directory and the VMs are substituted at their boundaries; model logic is real.
@Suite @MainActor struct MachinesModelTests {
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
        await fixture.model.disconnectAll() // Cancels the pending admission.
        for session in fixture.sessions.started { session.finishShutdown() }
        _ = await archive.value
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
        let removal = Task { await fixture.model.remove("studio") }
        await drain()
        #expect(studio.stopped)
        #expect(fixture.access.removed.isEmpty) // Waits for the runtime that holds the database.
        studio.finishShutdown()
        await removal.value
        #expect(fixture.access.removed == ["studio"])
        #expect(!FileManager.default.fileExists(atPath: database.path))
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
    let suite = "ace.tests.\(UUID().uuidString)"
    let model: MachinesModel
    init(machines: [MachineEntry]) throws {
        access = FakeAccess(machines)
        storage = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defaults = try #require(UserDefaults(suiteName: suite))
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
    init(_ machines: [MachineEntry]) { self.machines = machines }
    func perform(_ request: AccessRequest) async -> Result<AccessOutcome, ProblemNotice> {
        lock.withLock {
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
    func invoke(_ name: String, json: String) { lock.withLock { calls.append(json) } }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopRequested = true; self.completion = completion } }
    func finishShutdown() { let done = lock.withLock { let value = completion; completion = nil; return value }; done?() }
    func emit(_ json: String) { receive(Data(json.utf8)) }
}
