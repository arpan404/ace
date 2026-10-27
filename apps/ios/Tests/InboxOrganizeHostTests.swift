import Foundation
import Testing
@testable import Ace

/// Organizing against machines that answer late, refuse some threads or hold a snooze: a thread
/// counts as done only once its machine took the action, and Undo restores what each action
/// changed, keeping any thread its machine wouldn't put back.
@Suite @MainActor struct InboxOrganizeHostTests {
    @Test func aDeleteStillWaitingOnItsMachineIsPendingNotDeleted() async {
        let host = FakeHost()
        host.answers = [BulkOutcome(saved: ["a", "b"], waiting: ["b"])]
        let organize = InboxOrganize()
        let keys = [InboxKey(machineId: "mac", id: "a"), InboxKey(machineId: "mac", id: "b")]
        await organize.confirmDelete(DeleteAsk(keys: keys, question: question), in: host)
        #expect(organize.deleted == [keys[0]])
        #expect(organize.pending == [keys[1]])

        // Refused later only because work still runs: still not deleted, and asked again.
        host.finish("organize-1", BulkOutcome(saved: ["b"], running: ["b"], retry: retry))
        await settle { organize.pending.isEmpty }
        #expect(organize.deleted == [keys[0]])
        #expect(organize.deleting?.keys == [keys[1]])
        #expect(organize.deleting?.question.confirm == "Stop and delete")
    }

    @Test func archivingCountsWaitingThreadsAsPendingAndUndoesOnlyWhatWasTaken() async {
        let host = FakeHost()
        host.answers = [BulkOutcome(saved: ["a", "b"], waiting: ["b"])]
        let organize = InboxOrganize()
        let keys = [InboxKey(machineId: "mac", id: "a"), InboxKey(machineId: "mac", id: "b")]
        await organize.run(.archive, keys, in: host)
        #expect(organize.undo?.keys == [keys[0]])
        #expect(organize.undo?.text == "Archived 2 threads · 1 waiting")
        // Taken while the toast shows: it joins the Undo.
        host.finish("organize-1", BulkOutcome(saved: ["b"]))
        await settle { organize.undo?.keys.count == 2 }
        #expect(organize.undo?.text == "Archived 2 threads")
    }

    @Test func undoOfASettleTakesBackOnlyTheSettleAndPutsTheSnoozeBack() async {
        let host = FakeHost()
        let key = InboxKey(machineId: "mac", id: "a")
        host.rows[key] = FakeHost.row("a", snoozedUntil: host.clock() + 3_600_000)
        host.answers = [BulkOutcome(saved: ["a"]), BulkOutcome(saved: ["a"])]
        let organize = InboxOrganize()
        await organize.run(.settle, [key], in: host)
        let undo = try! #require(organize.undo)
        #expect(await organize.takeBack(undo, in: host))
        #expect(host.sent.map(\.action) == [.settle, .undoSettle])
        #expect(host.snoozes[key] == host.rows[key]?.snoozedUntil)
    }

    @Test func undoOfAMoveSendsEachThreadBackToItsOwnProject() async {
        let host = FakeHost()
        let a = InboxKey(machineId: "mac", id: "a"), b = InboxKey(machineId: "mac", id: "b")
        host.answers = [BulkOutcome(saved: ["a"]), BulkOutcome(saved: ["b"])]
        let organize = InboxOrganize()
        let undo = InboxUndo(keys: [a, b], kind: .moved(from: [a: "ace", b: "notes"]), text: "Moved 2 threads")
        #expect(await organize.takeBack(undo, in: host))
        let moves = host.sent.map { "\($0.ids.joined()):\($0.workspaceId ?? "")" }.sorted()
        #expect(moves == ["a:ace", "b:notes"])
    }

    @Test func undoThatTheMachinePartlyRefusesSaysWhichAndStaysUndoable() async {
        let host = FakeHost()
        let a = InboxKey(machineId: "mac", id: "a"), b = InboxKey(machineId: "mac", id: "b")
        host.rows[b] = FakeHost.row("b", title: "Fix login")
        host.answers = [BulkOutcome(saved: ["a"], refused: [.init(threadId: "b", message: "The thread is gone.")])]
        let organize = InboxOrganize()
        let undone = await organize.takeBack(InboxUndo(keys: [a, b], kind: .archived, text: "Archived 2 threads"), in: host)
        #expect(!undone)
        #expect(organize.undo?.keys == [b])
        #expect(organize.problem?.contains("Fix login") == true)
        #expect(organize.problem?.contains("The thread is gone.") == true)
    }

    @Test func projectChoicesAreRebuiltOnlyWhenTheListChanges() {
        var cache = ProjectChoiceCache()
        var builds = 0
        let build = { () -> [ProjectChoice] in builds += 1; return [ProjectChoice(id: "mac/ace", name: "ace")] }
        _ = cache.choices(for: ["mac", "a", "b"], build: build)
        _ = cache.choices(for: ["mac", "a", "b"], build: build)
        #expect(builds == 1)
        _ = cache.choices(for: ["mac", "a", "b", "c"], build: build)
        #expect(builds == 2)
    }

    @Test func aLinkThatArrivesBeforeTheAppIsReadyWaitsAndOpensOnce() {
        var links = PendingLinks()
        let url = URL(string: "ace://thread/t-1")!
        links.add(url)
        links.add(url)
        links.add(URL(string: "https://example.com")!)
        #expect(links.take(unlocked: false, machinesReady: true).isEmpty)
        #expect(links.take(unlocked: true, machinesReady: false).isEmpty)
        #expect(links.take(unlocked: true, machinesReady: true) == [url])
        #expect(links.take(unlocked: true, machinesReady: true).isEmpty)
    }

    private let question = DeleteQuestion(title: "Delete 2 threads?", message: "", running: "", confirm: "Delete", force: false)
    private let retry = DeleteQuestion(title: "Delete thread?", message: "", running: "", confirm: "Stop and delete", force: true)

    private func settle(_ done: () -> Bool) async {
        for _ in 0..<200 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
    }
}

@MainActor private final class FakeHost: OrganizeHost {
    struct Sent { let action: BulkAction; let ids: [String]; let workspaceId: String?; let ticket: String }
    var answers: [BulkOutcome] = []
    var sent: [Sent] = []
    var rows: [InboxKey: ThreadRow] = [:]
    var snoozes: [InboxKey: Double] = [:]
    private var finals: [String: CheckedContinuation<BulkOutcome?, Never>] = [:]
    private var early: [String: BulkOutcome] = [:]

    func bulk(_ machineId: String, _ action: BulkAction, _ ids: [String], workspaceId: String?, force: Bool, ticket: String) async -> BulkOutcome {
        sent.append(Sent(action: action, ids: ids, workspaceId: workspaceId, ticket: ticket))
        return answers.isEmpty ? BulkOutcome(saved: ids) : answers.removeFirst()
    }
    func final(_ machineId: String, ticket: String) async -> BulkOutcome? {
        if let outcome = early.removeValue(forKey: ticket) { return outcome }
        return await withCheckedContinuation { finals[ticket] = $0 }
    }
    func finish(_ ticket: String, _ outcome: BulkOutcome) {
        if let waiting = finals.removeValue(forKey: ticket) { waiting.resume(returning: outcome) } else { early[ticket] = outcome }
    }
    func snooze(_ key: InboxKey, until: Double?) async -> Bool { snoozes[key] = until; return true }
    func deleteQuestion(_ machineId: String, _ ids: [String]) async -> DeleteQuestion? { nil }
    func row(_ key: InboxKey) -> ThreadRow? { rows[key] }
    func clock() -> Double { 1_800_000_000_000 }

    static func row(_ id: String, title: String? = nil, snoozedUntil: Double? = nil) -> ThreadRow {
        ThreadRow(id: id, title: title ?? id, state: "done", attention: nil, project: "ace", branch: "", machine: "", provider: "codex",
                  model: "", agents: 1, snoozedUntil: snoozedUntil, updatedAt: 1, canSteer: false,
                  status: StatusDisplay(label: "Done", token: "done"), machineId: "mac", activityAt: nil)
    }
}
