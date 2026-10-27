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
        // Undo covers the waiting thread too.
        #expect(organize.undo?.keys == keys)
        #expect(organize.undo?.text == "Archived 2 threads · 1 waiting")
        host.finish("organize-1", BulkOutcome(saved: ["b"]))
        await settle { organize.undo?.text == "Archived 2 threads" }
        #expect(organize.undo?.keys == keys)
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

    @Test func undoOfASettleStillWaitingWaitsForItThenTakesItBack() async {
        let host = FakeHost()
        let key = InboxKey(machineId: "mac", id: "a")
        host.answers = [BulkOutcome(saved: ["a"], waiting: ["a"]), BulkOutcome(saved: ["a"])]
        let organize = InboxOrganize()
        await organize.run(.settle, [key], in: host)
        let undo = try! #require(organize.undo)
        #expect(undo.keys == [key])
        let back = Task { await organize.takeBack(undo, in: host) }
        await settle { organize.undo?.busy == true }
        // Nothing to take back until the settle itself lands, and no success reported meanwhile.
        #expect(host.sent.map(\.action) == [.settle])
        #expect(organize.undo?.busy == true)
        host.finish("organize-1", BulkOutcome(saved: ["a"]))
        #expect(await back.value)
        #expect(host.sent.map(\.action) == [.settle, .undoSettle])
        #expect(organize.undo == nil)
    }

    @Test func undoOfAMoveCoversTakenAndWaitingThreads() async {
        let host = FakeHost()
        let a = InboxKey(machineId: "mac", id: "a"), b = InboxKey(machineId: "mac", id: "b")
        host.rows[a] = FakeHost.row("a", workspaceId: "ace"); host.rows[b] = FakeHost.row("b", workspaceId: "ace")
        host.answers = [BulkOutcome(saved: ["a", "b"], waiting: ["b"]), BulkOutcome(saved: ["a", "b"])]
        let organize = InboxOrganize()
        await organize.move([a, b], to: ComposeProject(id: "notes", name: "notes", path: "/n", recent: false), in: host)
        let undo = try! #require(organize.undo)
        #expect(Set(undo.keys) == [a, b])
        #expect(undo.text == "Moved 2 threads to notes · 1 waiting")
        let back = Task { await organize.takeBack(undo, in: host) }
        await settle { host.sent.count >= 1 && organize.undo?.busy == true }
        host.finish("organize-1", BulkOutcome(saved: ["b"]))
        #expect(await back.value)
        // Both go back once b's own move landed: none is left behind in the other project.
        #expect(host.sent.dropFirst().map { "\($0.ids.sorted().joined()):\($0.workspaceId ?? "")" } == ["ab:ace"])
    }

    @Test func aMoveTheMachineRefusesLaterLeavesTheToastsUndo() async {
        let host = FakeHost()
        let a = InboxKey(machineId: "mac", id: "a"), b = InboxKey(machineId: "mac", id: "b")
        host.rows[a] = FakeHost.row("a", workspaceId: "ace"); host.rows[b] = FakeHost.row("b", workspaceId: "ace")
        host.answers = [BulkOutcome(saved: ["a", "b"], waiting: ["b"])]
        let organize = InboxOrganize()
        await organize.move([a, b], to: ComposeProject(id: "notes", name: "notes", path: "/n", recent: false), in: host)
        host.finish("organize-1", BulkOutcome(saved: ["b"], refused: [.init(threadId: "b", message: "Stop its agents first.")]))
        await settle { organize.undo?.keys == [a] }
        #expect(organize.undo?.text == "Moved thread to notes")
        #expect(organize.problem == "Stop its agents first.")
    }

    @Test func anUndoTheMachineRefusesLaterIsReportedAndStaysUndoable() async {
        let host = FakeHost()
        let a = InboxKey(machineId: "mac", id: "a")
        host.rows[a] = FakeHost.row("a", title: "Fix login")
        host.answers = [BulkOutcome(saved: ["a"], waiting: ["a"])]
        let organize = InboxOrganize()
        let undone = await organize.takeBack(InboxUndo(keys: [a], kind: .archived, text: "Archived thread"), in: host)
        // The unarchive still waits: not a success, and the toast says so.
        #expect(!undone)
        #expect(organize.undo?.busy == true)
        host.finish("organize-1", BulkOutcome(saved: ["a"], refused: [.init(threadId: "a", message: "The thread is gone.")]))
        await settle { organize.undo?.busy == false }
        #expect(organize.undo?.keys == [a])
        #expect(organize.problem?.contains("Fix login") == true)
    }

    @Test func projectChoicesFollowARowsProjectChangeAndIgnoreItsOtherChanges() {
        let row = FakeHost.row("a", workspaceId: "ace")
        var busy = row; busy.workspaceId = "ace"
        var moved = row; moved.workspaceId = "notes"
        #expect(!ProjectChoice.changes(row, busy))
        #expect(ProjectChoice.changes(row, moved))
        #expect(ProjectChoice.changes(nil, row))
        #expect(ProjectChoice.changes(row, nil))
    }

    @Test func withNoMachinePairedSettingsAndNewThreadLinksOpenAndThreadLinksWait() {
        var links = PendingLinks()
        let settings = URL(string: "ace://settings/appearance")!
        let thread = URL(string: "ace://thread/t-1")!
        links.add(settings); links.add(thread)
        #expect(links.take(unlocked: true, machinesReady: false, noMachines: true) == [settings])
        #expect(links.waiting == [thread])
        #expect(OpenedLink.withoutMachine(settings) == OpenedLink(kind: "settings", page: "appearance"))
        #expect(OpenedLink.withoutMachine(URL(string: "ace://new")!) == OpenedLink(kind: "new-thread"))
        #expect(OpenedLink.withoutMachine(thread) == nil)
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
    var snoozeRefusal: String?
    func snooze(_ key: InboxKey, until: Double?) async -> String? { snoozes[key] = until; return snoozeRefusal }
    func deleteQuestion(_ machineId: String, _ ids: [String]) async -> DeleteQuestion? { nil }
    func row(_ key: InboxKey) -> ThreadRow? { rows[key] }
    func clock() -> Double { 1_800_000_000_000 }

    static func row(_ id: String, title: String? = nil, snoozedUntil: Double? = nil, workspaceId: String? = nil) -> ThreadRow {
        var row = ThreadRow(id: id, title: title ?? id, state: "done", attention: nil, project: "ace", branch: "", machine: "", provider: "codex",
                            model: "", agents: 1, snoozedUntil: snoozedUntil, updatedAt: 1, canSteer: false,
                            status: StatusDisplay(label: "Done", token: "done"), machineId: "mac", activityAt: nil)
        row.workspaceId = workspaceId
        return row
    }
}
