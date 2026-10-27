import Foundation
import Observation

/// A settle, archive or move the person can take back from the toast, for one thread or several.
struct InboxUndo: Equatable {
    enum Kind: Equatable {
        case settled, archived
        /// Each thread's project before the move.
        case moved(from: [InboxKey: String])
    }
    let keys: [InboxKey]
    let kind: Kind
    /// The toast's words: "Settled thread", "Archived 3 threads", "Moved to notes".
    let text: String
    /// Two undos for the same threads still show as new toasts.
    var serial = UUID()

    init(keys: [InboxKey], kind: Kind, text: String) { self.keys = keys; self.kind = kind; self.text = text }
    /// One thread settled or archived from its row.
    init(key: InboxKey, kind: Kind) {
        self.init(keys: [key], kind: kind, text: kind == .settled ? "Settled thread" : "Archived thread")
    }
}

/// The question a delete waits on: which threads, and the shared words for it.
struct DeleteAsk: Identifiable, Equatable {
    let id = UUID()
    let keys: [InboxKey]
    let question: DeleteQuestion
}

/// Threads picked for a move: the sheet lists the projects of their one machine.
struct MoveAsk: Identifiable, Equatable {
    let id = UUID()
    let machineId: String
    let keys: [InboxKey]
}

/// The thread actions that span the inbox's machines: delete with its question (and Stop and
/// delete for work that still runs), move with the project sheet, and every action on several
/// threads at once. Each machine runs its own threads' commands (`ClientModel.bulk`); the words
/// and rules come from the shared runtime. Swift only groups by machine and shows the answers.
@MainActor @Observable final class InboxOrganize {
    var deleting: DeleteAsk?
    var moving: MoveAsk?
    /// What the machines refused, for one alert.
    var problem: String?
    var undo: InboxUndo?
    /// Threads gone for good, so a page open on one of them closes.
    var deleted: Set<InboxKey> = []

    /// Each machine's threads among `keys`, in the order given.
    static func byMachine(_ keys: [InboxKey]) -> [(machineId: String, ids: [String])] {
        var order: [String] = []
        var groups: [String: [String]] = [:]
        for key in keys {
            if groups[key.machineId] == nil { order.append(key.machineId) }
            groups[key.machineId, default: []].append(key.id)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    /// Ask before deleting `keys` for good. One machine words the question; across several the
    /// count and whether running work stops are put together from each machine's answer.
    func askDelete(_ keys: [InboxKey], in inbox: MachineInbox) async {
        guard !keys.isEmpty else { return }
        var questions: [DeleteQuestion] = []
        for group in Self.byMachine(keys) {
            if let question = await inbox.client(group.machineId)?.deleteQuestion(group.ids) { questions.append(question) }
        }
        guard let first = questions.first else { problem = "Couldn't reach the machine to delete that. Try again once it's connected."; return }
        let question = questions.count == 1 ? first : Self.combined(questions, count: keys.count)
        deleting = DeleteAsk(keys: keys, question: question)
    }

    static func combined(_ questions: [DeleteQuestion], count: Int) -> DeleteQuestion {
        let force = questions.contains(where: \.force)
        let running = force ? "Running work will stop before deletion." : ""
        return DeleteQuestion(title: "Delete \(count) threads?",
                              message: "\(count) threads will be permanently deleted." + (force ? " \(running)" : ""),
                              running: running, confirm: force ? "Stop and delete" : "Delete", force: force)
    }

    /// The person confirmed: delete now, with no Undo. Threads refused only because their
    /// agents or terminals still run are asked about again as one Stop and delete.
    func confirmDelete(_ ask: DeleteAsk, in inbox: MachineInbox) async {
        deleting = nil
        var running: [InboxKey] = []
        var retries: [DeleteQuestion] = []
        var refused: [String] = []
        for group in Self.byMachine(ask.keys) {
            guard let client = inbox.client(group.machineId) else { continue }
            let outcome = await client.bulk(.delete, group.ids, force: ask.question.force)
            let gone = Set(outcome.saved).subtracting(outcome.running).subtracting(outcome.refused.map(\.threadId))
            deleted.formUnion(gone.map { InboxKey(machineId: group.machineId, id: $0) })
            running += outcome.running.map { InboxKey(machineId: group.machineId, id: $0) }
            if let retry = outcome.retry { retries.append(retry) }
            refused += outcome.refused.map(\.message)
        }
        report(refused, doing: "delete")
        guard let first = retries.first, !running.isEmpty else { return }
        deleting = DeleteAsk(keys: running, question: retries.count == 1 ? first : Self.combined(retries, count: running.count))
    }

    /// One action on several threads, across machines. Settle, archive and pin of several
    /// confirm with a toast offering Undo where the action has an opposite.
    func run(_ action: BulkAction, _ keys: [InboxKey], in inbox: MachineInbox) async {
        guard !keys.isEmpty else { return }
        if action == .delete { await askDelete(keys, in: inbox); return }
        var done: [InboxKey] = []
        var refused: [String] = []
        for group in Self.byMachine(keys) {
            guard let client = inbox.client(group.machineId) else { continue }
            let outcome = await client.bulk(action, group.ids)
            let failed = Set(outcome.refused.map(\.threadId))
            done += outcome.saved.filter { !failed.contains($0) }.map { InboxKey(machineId: group.machineId, id: $0) }
            refused += outcome.refused.map(\.message)
        }
        report(refused, doing: action.rawValue)
        guard !done.isEmpty else { return }
        switch action {
        case .settle: undo = InboxUndo(keys: done, kind: .settled, text: Self.counted("Settled", done.count))
        case .archive: undo = InboxUndo(keys: done, kind: .archived, text: Self.counted("Archived", done.count))
        default: break
        }
    }

    /// Move `keys` (all on one machine) to `project`, with Undo back to where each was.
    func move(_ keys: [InboxKey], to project: ComposeProject, in inbox: MachineInbox) async {
        guard let machineId = keys.first?.machineId, let client = inbox.client(machineId) else { return }
        moving = nil
        var from: [InboxKey: String] = [:]
        for key in keys { if let workspace = inbox.row(key)?.workspaceId, workspace != project.id { from[key] = workspace } }
        guard !from.isEmpty else { return }
        let ids = keys.filter { from[$0] != nil }.map(\.id)
        let outcome = await client.bulk(.move, ids, workspaceId: project.id)
        let failed = Set(outcome.refused.map(\.threadId))
        report(outcome.refused.map(\.message), doing: "move")
        let moved = from.filter { outcome.saved.contains($0.key.id) && !failed.contains($0.key.id) }
        guard !moved.isEmpty else { return }
        undo = InboxUndo(keys: Array(moved.keys), kind: .moved(from: moved),
                         text: moved.count == 1 ? "Moved to \(project.name)" : "Moved \(moved.count) threads to \(project.name)")
    }

    /// Take back the toast's action; resolves with whether every machine saved it.
    func takeBack(_ undo: InboxUndo, in inbox: MachineInbox) async -> Bool {
        self.undo = nil
        var ok = true
        switch undo.kind {
        case .settled, .archived:
            let action: BulkAction = undo.kind == .settled ? .unsettle : .unarchive
            for group in Self.byMachine(undo.keys) {
                guard let client = inbox.client(group.machineId) else { ok = false; continue }
                ok = await !client.bulk(action, group.ids).saved.isEmpty && ok
            }
        case .moved(let from):
            for (key, workspace) in from {
                ok = await inbox.client(key.machineId)?.moveThread(key.id, to: workspace) == true && ok
            }
        }
        return ok
    }

    private func report(_ refused: [String], doing verb: String) {
        guard let first = refused.first else { return }
        problem = refused.count == 1 ? first : "Couldn't \(verb) \(refused.count) threads. \(first)"
    }

    static func counted(_ verb: String, _ count: Int) -> String {
        count == 1 ? "\(verb) thread" : "\(verb) \(count) threads"
    }
}
