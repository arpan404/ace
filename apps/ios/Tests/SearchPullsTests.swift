import Foundation
import Testing
@testable import Ace

/// Search's pull requests come from one ready machine. A machine that goes away takes its rows
/// with it, whatever the next machine's read does, so a row never opens on a machine that's gone.
@MainActor @Suite struct SearchPullsTests {
    @Test func aDisconnectedMachinesPullsGoWhenTheNextMachinesReadTimesOut() async throws {
        let (inbox, desk, _) = try twoReadyMachines()
        var pulls: SearchPulls?
        var keptDuringRead: [String]?
        pulls = SearchPulls { client, _ in
            if client === desk { return (project: "ace", rows: [try row(212, "Bump Codex app-server")]) }
            // Laptop's read is still out: desk's rows must already be gone.
            keptDuringRead = pulls?.found.map(\.route.machineId)
            throw ServiceFailure(message: "Timed out", transport: true)
        }
        let search = try #require(pulls)
        await search.run(inbox, query: "codex")
        #expect(search.visible(inbox).map(\.route.machineId) == ["desk"])

        drop(desk)
        // Before the search runs again, the rows of a machine that's gone already don't show.
        #expect(search.visible(inbox).isEmpty)
        await search.run(inbox, query: "codex")
        #expect(keptDuringRead == [])
        #expect(search.found.isEmpty)
        #expect(search.visible(inbox).isEmpty)
        // The ready machine's read failed: that is still worth Try again.
        #expect(search.problem != nil)
    }

    /// Rows read before a machine dropped belong to that socket. Back on a new one, they stay
    /// gone with no search having run meanwhile (the list was on Messages), even when the drop
    /// and the recovery reached the phone as one "ready"; a read that then times out leaves Try
    /// again alone, not the old rows beside it.
    @Test func aMachinesPullsFromBeforeItReconnectedDontComeBack() async throws {
        let (inbox, desk, laptop) = try twoReadyMachines()
        drop(laptop)
        let pulls = SearchPulls(read: answerOnceThenTimeOut())
        await pulls.run(inbox, query: "codex")
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])

        ready(desk, socket: 2)
        #expect(desk.connection == "ready")
        #expect(pulls.visible(inbox).isEmpty)
        await pulls.run(inbox, query: "codex")
        #expect(pulls.found.isEmpty)
        #expect(pulls.visible(inbox).isEmpty)
        #expect(pulls.problem != nil)
    }

    /// A machine paired again gets a new client whose sockets count from the start: the old
    /// client's rows don't pass for the new one's, though the socket numbers match.
    @Test func aReplacedClientsFirstConnectionDoesntRevivePullsFromTheOldOne() async throws {
        let (inbox, desk, laptop) = try twoReadyMachines()
        drop(laptop)
        let pulls = SearchPulls(read: answerOnceThenTimeOut())
        await pulls.run(inbox, query: "codex")
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])

        let replacement = ClientModel(now: { 0 })
        ready(replacement, socket: 1)
        inbox.attach("desk", name: "Desk", client: replacement)
        #expect(pulls.visible(inbox).isEmpty)
        await pulls.run(inbox, query: "codex")
        #expect(pulls.found.isEmpty)
        #expect(pulls.problem != nil)
        // The old client is still alive, so only its identity tells the rows apart.
        #expect(desk.connection == "ready")
    }

    /// A switch between direct and relay keeps the client but starts a new runtime, whose
    /// sockets count from 1 again: rows read on the old runtime's socket 1 stay gone.
    @Test func aRuntimeSwapThatRestartsTheSocketDoesntRevivePulls() async throws {
        let inbox = MachineInbox(defaults: try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")), now: { 0 })
        let sessions = FakeMachineSessions()
        let desk = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        inbox.attach("desk", name: "Desk", client: desk)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        await desk.connect(target: try target("ws://192.168.1.20:9443"), directory: directory)
        let direct = try #require(sessions.started.last)
        direct.emit(#"[{"type":"connection","state":"ready","socket":1}]"#)
        await settle { desk.connection == "ready" }
        let pulls = SearchPulls(read: answerOnceThenTimeOut())
        await pulls.run(inbox, query: "codex")
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])

        direct.finishShutdownWhenStopped()
        await desk.connect(target: try target("wss://relay.example/desk"), directory: directory)
        let relay = try #require(sessions.started.last)
        #expect(relay !== direct)
        relay.emit(#"[{"type":"connection","state":"ready","socket":1}]"#)
        await settle { desk.connection == "ready" }
        #expect(desk.connection == "ready")
        #expect(pulls.visible(inbox).isEmpty)
        await pulls.run(inbox, query: "codex")
        #expect(pulls.found.isEmpty)
        #expect(pulls.problem != nil)
        desk.disconnect()
    }

    /// Only the machine that went away loses its rows: a ready machine's stay over its own
    /// failed read, as they do with one machine.
    @Test func aReadyMachinesPullsStayWhileAnotherMachineDisconnects() async throws {
        let (inbox, _, laptop) = try twoReadyMachines()
        let pulls = SearchPulls(read: answerOnceThenTimeOut())
        await pulls.run(inbox, query: "codex")
        drop(laptop)
        await pulls.run(inbox, query: "codex")
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])
        #expect(pulls.problem != nil)
    }

    // MARK: Helpers

    private func twoReadyMachines() throws -> (MachineInbox, ClientModel, ClientModel) {
        let inbox = MachineInbox(defaults: try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")), now: { 0 })
        let desk = ClientModel(now: { 0 }), laptop = ClientModel(now: { 0 })
        ready(desk, socket: 1)
        ready(laptop, socket: 1)
        inbox.attach("desk", name: "Desk", client: desk)
        inbox.attach("laptop", name: "Laptop", client: laptop)
        return (inbox, desk, laptop)
    }

    /// The bridge's connection patch: ready on a daemon socket, or reconnecting with none.
    private func ready(_ client: ClientModel, socket: Int) {
        _ = client.hold([.connection("ready", nil, socket: socket)], bytes: 0)
    }
    private func drop(_ client: ClientModel) {
        _ = client.hold([.connection("reconnecting", nil, socket: nil)], bytes: 0)
    }

    private func target(_ endpoint: String) throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: endpoint)), hostId: "desk", deviceId: "phone", pin: nil, credential: { "{}" })
    }
    /// Frames decode off the main actor before they apply: wait, briefly, for `done`.
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<200 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    /// The first read finds #212; every later one times out.
    private func answerOnceThenTimeOut() -> SearchPulls.Read {
        var reads = 0
        return { _, _ in
            reads += 1
            if reads == 1 { return (project: "ace", rows: [try row(212, "Bump Codex app-server")]) }
            throw ServiceFailure(message: "Timed out", transport: true)
        }
    }

    private func row(_ number: Int, _ title: String) throws -> ForgePullRow {
        let json = """
        {"key":"github.com/acme/ace#\(number)","number":\(number),
         "repository":{"forge":"github","host":"github.com","owner":"acme","name":"ace"},
         "title":"\(title)","url":"https://github.com/acme/ace/pull/\(number)",
         "state":{"word":"Open","tone":"open"},"merged":false,"conflicting":false,"labels":[],
         "comments":0,"author":"mira","stepNeedsYou":false}
        """
        return try JSONDecoder().decode(ForgePullRow.self, from: Data(json.utf8))
    }
}
