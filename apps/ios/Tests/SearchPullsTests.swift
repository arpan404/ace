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

        desk.connection = "reconnecting"
        // Before the search runs again, the rows of a machine that's gone already don't show.
        #expect(search.visible(inbox).isEmpty)
        await search.run(inbox, query: "codex")
        #expect(keptDuringRead == [])
        #expect(search.found.isEmpty)
        #expect(search.visible(inbox).isEmpty)
        // The ready machine's read failed: that is still worth Try again.
        #expect(search.problem != nil)
    }

    /// Rows read before a machine dropped belong to that connection. Back on a new one, they
    /// stay gone with no search having run meanwhile (the list was on Messages), and a read
    /// that then times out leaves Try again alone, not the old rows beside it.
    @Test func aMachinesPullsFromBeforeItReconnectedDontComeBack() async throws {
        let (inbox, desk, laptop) = try twoReadyMachines()
        laptop.connection = "reconnecting"
        var reads = 0
        let pulls = SearchPulls { _, _ in
            reads += 1
            if reads == 1 { return (project: "ace", rows: [try row(212, "Bump Codex app-server")]) }
            throw ServiceFailure(message: "Timed out", transport: true)
        }
        await pulls.run(inbox, query: "codex")
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])

        desk.connection = "reconnecting"
        desk.connection = "ready"
        #expect(pulls.visible(inbox).isEmpty)
        await pulls.run(inbox, query: "codex")
        #expect(reads == 2)
        #expect(pulls.found.isEmpty)
        #expect(pulls.visible(inbox).isEmpty)
        #expect(pulls.problem != nil)
    }

    /// Only the machine that went away loses its rows: a ready machine's stay over its own
    /// failed read, as they do with one machine.
    @Test func aReadyMachinesPullsStayWhileAnotherMachineDisconnects() async throws {
        let (inbox, _, laptop) = try twoReadyMachines()
        var reads = 0
        let pulls = SearchPulls { _, _ in
            reads += 1
            if reads == 1 { return (project: "ace", rows: [try row(212, "Bump Codex app-server")]) }
            throw ServiceFailure(message: "Timed out", transport: true)
        }
        await pulls.run(inbox, query: "codex")
        laptop.connection = "reconnecting"
        await pulls.run(inbox, query: "codex")
        #expect(reads == 2)
        #expect(pulls.visible(inbox).map(\.route.machineId) == ["desk"])
        #expect(pulls.problem != nil)
    }

    // MARK: Helpers

    private func twoReadyMachines() throws -> (MachineInbox, ClientModel, ClientModel) {
        let inbox = MachineInbox(defaults: try #require(UserDefaults(suiteName: "ace.tests.\(UUID().uuidString)")), now: { 0 })
        let desk = ClientModel(now: { 0 }), laptop = ClientModel(now: { 0 })
        desk.connection = "ready"
        laptop.connection = "ready"
        inbox.attach("desk", name: "Desk", client: desk)
        inbox.attach("laptop", name: "Laptop", client: laptop)
        return (inbox, desk, laptop)
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
