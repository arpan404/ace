import Foundation
import Testing
@testable import Ace

/// The SDK directory and the VM are substituted at their boundaries; model logic is real.
@Suite @MainActor struct MachinesModelTests {
    @Test func switchingMachinesWaitsForTheOldRuntimeAndBindsEachToItsOwnHostAndDevice() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let first = try #require(fixture.sessions.started.first)
        #expect(first.target.hostId == "studio")
        #expect(first.target.endpoint.scheme == "wss")
        #expect(first.target.pin == DaemonCertificate.pin)
        #expect(first.target.secretKey == "[\"studio\",\"phone-1\"]")
        #expect(first.storage == ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage))

        let switching = Task { await fixture.model.select("laptop") }
        for _ in 0..<20 { await Task.yield() }
        // The next machine's runtime cannot open its storage before the old VM shut down.
        #expect(fixture.sessions.started.count == 1)
        first.finishShutdown()
        await switching.value
        let second = try #require(fixture.sessions.started.last)
        #expect(second.target.hostId == "laptop")
        #expect(second.storage != first.storage)
        // Late facts from the retired runtime are discarded.
        first.emit(#"[{"type":"connection","state":"ready"}]"#)
        second.emit(#"[{"type":"connection","state":"reconnecting"},{"type":"connection.problem","problem":{"code":"unreachable","message":"Can't reach"}}]"#)
        for _ in 0..<20 { await Task.yield() }
        #expect(fixture.model.client.connection == "reconnecting")
        #expect(fixture.model.client.problem?.code == "unreachable")
        // A relaunch reconnects to the machine chosen last.
        let relaunched = MachinesModel(client: ClientModel(now: { 0 }, makeRuntime: fixture.sessions.make), access: fixture.access,
                                       storage: fixture.storage, defaults: fixture.defaults)
        second.finishShutdown()
        await relaunched.load()
        #expect(fixture.sessions.started.last?.target.hostId == "laptop")
    }

    @Test func pairingStoresTheGrantAndConnectsToTheNewMachine() async throws {
        let fixture = try Fixture(machines: [])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(fixture.sessions.started.isEmpty)
        fixture.access.pairing = .success(machine("studio", device: "phone-1"), scopes: ["read"])
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc&scopes=read")
        #expect(await fixture.model.pair(link, name: "Phone") == nil)
        #expect(fixture.model.active?.hostId == "studio")
        #expect(fixture.model.activeIsReadOnly)
        #expect(fixture.sessions.started.last?.target.hostId == "studio")
    }

    @Test func aViewOnlyPhoneSubmitsNoCommandsUntilItsMachineAllowsActing() async throws {
        let fixture = try Fixture(machines: [machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        fixture.access.pairing = .success(machine("studio", device: "phone-1"), scopes: ["read"])
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc&scopes=read")
        let pairing = Task { await fixture.model.pair(link, name: "Phone") }
        for _ in 0..<20 { await Task.yield() }
        fixture.sessions.started.first?.finishShutdown()
        #expect(await pairing.value == nil)
        let client = fixture.model.client
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
        // The other machine paired with View and act takes commands again.
        let switching = Task { await fixture.model.select("laptop") }
        for _ in 0..<20 { await Task.yield() }
        viewOnly.finishShutdown()
        await switching.value
        #expect(client.canOperate)
        let operating = try #require(fixture.sessions.started.last)
        client.open("thread-1")
        // Stop is offered only when the bridge's canonical controls say the tree can stop.
        let epoch = try #require(client.thread?.epoch)
        let controls: [[String: Any]] = [["type": "thread.controls", "threadId": "thread-1", "epoch": epoch,
                                          "row": ["busy": true, "delivery": "queue", "alternate": NSNull(), "canStop": true, "provider": "codex", "model": "", "switching": ""]]]
        client.receive(try JSONSerialization.data(withJSONObject: controls))
        client.stopTree()
        #expect(operating.submitted.count == 1)
    }

    @Test func notificationsBindToEachMachineBeforeItsRuntimeOpens() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        var bound: [(host: String, runtimesBefore: Int)] = []
        fixture.model.beforeConnect = { _, target in bound.append((target.hostId, fixture.sessions.started.count)) }
        await fixture.model.load()
        let switching = Task { await fixture.model.select("laptop") }
        for _ in 0..<20 { await Task.yield() }
        try #require(fixture.sessions.started.first).finishShutdown()
        await switching.value
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

    @Test func removingTheActiveMachineDisconnectsDeletesItsLocalDataAndMovesOn() async throws {
        let fixture = try Fixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let first = try #require(fixture.sessions.started.first)
        let database = ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage)
        try FileManager.default.createDirectory(at: fixture.storage, withIntermediateDirectories: true)
        try Data("outbox".utf8).write(to: database)
        let removal = Task { await fixture.model.remove("studio") }
        for _ in 0..<20 { await Task.yield() }
        #expect(fixture.access.removed.isEmpty) // Waits for the runtime that holds the database.
        first.finishShutdown()
        await removal.value
        #expect(fixture.access.removed == ["studio"])
        #expect(!FileManager.default.fileExists(atPath: database.path))
        #expect(fixture.model.machines.map(\.hostId) == ["laptop"])
        #expect(fixture.sessions.started.last?.target.hostId == "laptop")
    }

    private func machine(_ host: String, device: String) -> MachineEntry {
        MachineEntry(hostId: host, displayName: host.capitalized, icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: device)
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
        model = MachinesModel(client: ClientModel(now: { 0 }, makeRuntime: sessions.make), access: access, storage: storage, defaults: defaults)
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
    private(set) var removed: [String] = []
    init(_ machines: [MachineEntry]) { self.machines = machines }
    func perform(_ request: AccessRequest) async -> Result<AccessOutcome, ProblemNotice> {
        lock.withLock {
            switch request {
            case .list: return .success(AccessOutcome(ok: true, machines: machines, paired: nil, problem: nil))
            case .remove(let host):
                removed.append(host)
                machines.removeAll { $0.hostId == host }
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
    private var stopped: (@Sendable () -> Void)?
    init(target: ConnectionTarget, storage: URL, receive: @escaping @Sendable (Data) -> Void) {
        self.target = target; self.storage = storage; self.receive = receive
    }
    func start(itemLimit: Int) {}
    /// Commands and inbox organization the model handed to the VM.
    var submitted: [String] { lock.withLock { invoked.filter { $0.contains("\"type\":\"command\"") || $0.contains("\"type\":\"inbox\"") || $0.contains("\"type\":\"thread\"") } } }
    private var invoked: [String] = []
    func invoke(_ name: String, json: String) { lock.withLock { invoked.append(json) } }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopped = completion } }
    func finishShutdown() { let done = lock.withLock { let value = stopped; stopped = nil; return value }; done?() }
    func emit(_ json: String) { receive(Data(json.utf8)) }
}
