import Foundation
import Testing
@testable import Ace

private let relayKey = String(repeating: "R", count: 52)

/// The sends an account runtime saved move into the paired machine it turns out to be (ADR
/// 0115), once each, whatever stops the phone on the way, and go over the relay until the daemon
/// has linked the account's device id to the pairing's.
@Suite(.timeLimit(.minutes(1))) @MainActor struct MachineSendAdoptionTests {
    @Test func aMoveCutShortBeforeItsDestinationCommittedIsDoneOnRelaunchAndTheSendIsReadThereOnce() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let held = HeldMove()
        let first = try MachinesFixture(machines: [studio], account: account, moveSends: held.move)
        defer { first.cleanUp() }
        let (accountStore, directStore) = try await queueOnAccountAndMerge(first)
        // The phone stops while the move is under way, before the paired store has the send.
        await settle { held.started }
        #expect(try records(directStore) == [])
        #expect(first.model.machines.map(\.hostId) == ["studio"])

        let second = try MachinesFixture(machines: [studio], account: account, defaults: first.defaults, storage: first.storage)
        await second.model.load()
        #expect(try records(directStore) == [send])
        #expect(try records(accountStore) == [other])
        // One runtime, on the machine's own store, sending over the relay with the pairing's proof.
        let runtime = try #require(second.sessions.started.first)
        #expect(second.sessions.started.allSatisfy { $0.storage == directStore })
        #expect(runtime.target.relay?.hostId == relayKey && runtime.target.deviceId == "ios-account-device")
        #expect(runtime.target.linkedPairing?.deviceId == "phone-1")
        #expect(second.model.inbox.sessions.map(\.hostId) == ["studio"])
        held.fail()
    }

    @Test func aMoveTheStoreRefusesStaysToBeDoneAndIsDoneOnceAfterRelaunch() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let attempts = Counter()
        let first = try MachinesFixture(machines: [studio], account: account, moveSends: { _, _, _ in
            attempts.add()
            throw HostError.storage
        })
        defer { first.cleanUp() }
        let (accountStore, directStore) = try await queueOnAccountAndMerge(first)
        await settle { attempts.count == 1 }
        #expect(try Set(records(accountStore)) == [send, other])
        // Tried again on the next change to the list, and still refused.
        await first.model.refreshAccount()
        #expect(attempts.count == 2)
        #expect(try records(directStore) == [])

        let second = try MachinesFixture(machines: [studio], account: account, defaults: first.defaults, storage: first.storage)
        await second.model.load()
        #expect(try records(directStore) == [send])
        #expect(try records(accountStore) == [other])
        await second.model.refreshAccount()
        #expect(try records(directStore) == [send])
        #expect(second.model.inbox.sessions.map(\.hostId) == ["studio"])
    }

    @Test func sendsTakenInGoOverTheRelayUntilItIsReadyOnceAndOnlyThenDoesTheMachineGoDirect() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio], account: account, probe: { _ in true })
        defer { fixture.cleanUp() }
        // Loading starts two runtimes, the pairing's and the account machine's; the third is the reopen.
        let before = 2
        let (_, directStore) = try await queueOnAccountAndMerge(fixture)
        await settle { fixture.sessions.started.count > before }
        let relay = try #require(fixture.sessions.started.last)
        relay.finishShutdownWhenStopped()
        #expect(relay.storage == directStore && relay.target.relay?.hostId == relayKey)
        #expect(relay.target.deviceId == "ios-account-device" && relay.target.deviceAliases == ["phone-1"])
        let opened = fixture.sessions.started.count

        // The direct address answers, past the hold, but the daemon hasn't linked the ids yet.
        fixture.clock.advance(MachineRoutePlan.hold)
        fixture.model.network(online: true, interfaceChanged: true)
        relay.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        await drain()
        #expect(fixture.sessions.started.count == opened)
        #expect(fixture.model.plans["studio"]?.current == .relay)

        // Ready over the relay: its hello linked them, and the machine goes back to direct.
        relay.emit(#"[{"type":"connection","state":"ready"}]"#)
        await settle { fixture.sessions.started.count > opened }
        let back = try #require(fixture.sessions.started.last)
        #expect(back.target.relay == nil && back.target.deviceId == "phone-1" && back.storage == directStore)
        #expect(fixture.model.plans["studio"]?.linking == false)
    }

    // MARK: Support

    private var studio: MachineEntry {
        MachineEntry(hostId: "studio", displayName: "Studio", icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: "phone-1", paths: nil)
    }
    private let send = #"{"command":{"id":"queued-on-relay","deviceId":"ios-account-device","payload":{"type":"thread.archive","threadId":"t1"}},"hostId":"studio","state":"pending","order":1}"#
    private let other = #"{"command":{"id":"for-another","deviceId":"ios-account-device","payload":{"type":"thread.archive","threadId":"t2"}},"hostId":"elsewhere","state":"pending","order":2}"#
    /// Loads the phone, queues `send` (and another daemon's `other`) through the account
    /// runtime, then has its daemon say it is the paired studio. The two runtimes' stores.
    private func queueOnAccountAndMerge(_ fixture: MachinesFixture) async throws -> (URL, URL) {
        await fixture.model.load()
        let accountRuntime = try #require(fixture.sessions.started.first { $0.target.relay != nil })
        let direct = try #require(fixture.sessions.started.first { $0.target.relay == nil })
        direct.finishShutdownWhenStopped()
        let saved = try DurableStore(url: accountRuntime.storage)
        _ = try saved.perform(HostRequest("storage.host.save", body: "studio"))
        _ = try saved.perform(HostRequest("storage.write", input: Data(#"{"id":"queued-on-relay"}"#.utf8), body: send))
        _ = try saved.perform(HostRequest("storage.write", input: Data(#"{"id":"for-another"}"#.utf8), body: other))
        accountRuntime.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio"}]"#)
        await settle { accountRuntime.stopped }
        accountRuntime.finishShutdown()
        await settle { fixture.model.machines.count == 1 }
        return (accountRuntime.storage, direct.storage)
    }
    private func records(_ database: URL) throws -> [String] {
        try JSONDecoder().decode([String].self, from: Data(DurableStore(url: database).perform(HostRequest("storage.records")).utf8))
    }
}

/// A move that starts and never finishes, as a phone stopped half way; `fail` ends it.
private final class HeldMove: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: CheckedContinuation<Int, any Error>?
    private var begun = false
    var started: Bool { lock.withLock { begun } }
    var move: SendAdoptions.Move {
        { _, _, _ in
            try await withCheckedThrowingContinuation { continuation in
                self.lock.withLock { self.begun = true; self.waiting = continuation }
            }
        }
    }
    func fail() { lock.withLock { let held = waiting; waiting = nil; return held }?.resume(throwing: HostError.storage) }
}
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func add() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}

@MainActor private func drain() async { for _ in 0..<20 { await Task.yield() } }
@MainActor private func settle(_ done: () -> Bool) async {
    for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
}
