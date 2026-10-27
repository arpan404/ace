import Foundation
import Observation

/// A settle, archive or move the person can take back from the toast, for one thread or several.
/// Each kind keeps what its action changed, so Undo puts exactly that back.
struct InboxUndo: Equatable {
    enum Kind: Equatable {
        /// Settling clears a snooze: each thread's snooze end before it was settled.
        case settled(snoozes: [InboxKey: Double])
        case archived
        /// Each thread's project before the move; moving back restores its details there.
        case moved(from: [InboxKey: String])
    }
    let keys: [InboxKey]
    let kind: Kind
    /// The toast's words: "Settled thread", "Archived 3 threads · 1 waiting", "Moved to notes".
    let text: String
    /// Two undos for the same threads still show as new toasts.
    var serial = UUID()

    init(keys: [InboxKey], kind: Kind, text: String) { self.keys = keys; self.kind = kind; self.text = text }

    var identifier: String {
        switch kind {
        case .settled: "inbox.undoSettle"
        case .archived: "inbox.undoArchive"
        case .moved: "inbox.undoMove"
        }
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

/// What organizing asks of the paired machines: `MachineInbox` in the app, a fake in tests.
@MainActor protocol OrganizeHost: AnyObject {
    /// One action on some of one machine's threads (`ClientModel.bulk`).
    func bulk(_ machineId: String, _ action: BulkAction, _ ids: [String], workspaceId: String?, force: Bool, ticket: String) async -> BulkOutcome
    /// The last answer for `ticket` when its first left threads waiting; nil when the machine
    /// goes away first, and they stay pending.
    func final(_ machineId: String, ticket: String) async -> BulkOutcome?
    func snooze(_ key: InboxKey, until: Double?) async -> Bool
    func deleteQuestion(_ machineId: String, _ ids: [String]) async -> DeleteQuestion?
    func row(_ key: InboxKey) -> ThreadRow?
    /// The phone's clock (ms).
    func clock() -> Double
}

/// The thread actions that span the inbox's machines: delete with its question (and Stop and
/// delete for work that still runs), move with the project sheet, and every action on one
/// thread or several. Each machine runs its own threads' commands; the words and rules come from
/// the shared runtime. A command saved here but not yet answered by its machine is pending, never
/// done: a page closes, and Undo offers a thread, only once its machine took the action.
@MainActor @Observable final class InboxOrganize {
    var deleting: DeleteAsk?
    var moving: MoveAsk?
    /// What the machines refused, for one alert.
    var problem: String?
    var undo: InboxUndo?
    /// Threads gone for good, confirmed by their machine, so a page open on one of them closes.
    var deleted: Set<InboxKey> = []
    /// Threads whose action this phone saved but their machine hasn't answered yet.
    private(set) var pending: Set<InboxKey> = []
    /// Bumped when an action lands (bulk, delete, move, Mark unread), for its haptic.
    var feedback = 0
    @ObservationIgnored private var tickets = 0

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

    /// One machine's answer sorted into what its machine took, what still waits, and what it
    /// refused (with its words). Threads left alone (already so) count as taken.
    struct Sorted {
        var taken: [InboxKey] = []
        var waiting: [InboxKey] = []
        var running: [InboxKey] = []
        var refused: [(key: InboxKey, message: String)] = []
        var retry: DeleteQuestion?
        init(_ machineId: String, _ outcome: BulkOutcome, requested: [String]) {
            let key = { InboxKey(machineId: machineId, id: $0) }
            let refusedIds = Set(outcome.refused.map(\.threadId))
            let runningIds = Set(outcome.running)
            let waitingIds = Set(outcome.waiting)
            let saved = Set(outcome.saved)
            let skipped = Set(outcome.skipped)
            for id in requested {
                if refusedIds.contains(id) || runningIds.contains(id) { continue }
                if waitingIds.contains(id) { waiting.append(key(id)) }
                else if saved.contains(id) || skipped.contains(id) { taken.append(key(id)) }
                else { refused.append((key(id), "Couldn't save that on this device.")) }
            }
            running = outcome.running.map(key)
            refused += outcome.refused.map { (key($0.threadId), $0.message) }
            retry = outcome.retry
        }
    }

    private func ticket() -> String { tickets += 1; return "organize-\(tickets)" }

    /// Runs `action` on every machine's share of `keys`; threads still waiting stay pending and
    /// `later` hears each machine's last answer for them.
    private func send(_ action: BulkAction, _ keys: [InboxKey], in host: any OrganizeHost, workspaceId: String? = nil,
                      force: Bool = false, later: @escaping (Sorted) -> Void = { _ in }) async -> Sorted {
        var all = Sorted("", BulkOutcome(), requested: [])
        for group in Self.byMachine(keys) {
            let ticket = ticket()
            let sorted = Sorted(group.machineId, await host.bulk(group.machineId, action, group.ids, workspaceId: workspaceId,
                                                                   force: force, ticket: ticket), requested: group.ids)
            all.taken += sorted.taken; all.waiting += sorted.waiting; all.running += sorted.running
            all.refused += sorted.refused; all.retry = all.retry ?? sorted.retry
            guard !sorted.waiting.isEmpty else { continue }
            let waiting = sorted.waiting
            pending.formUnion(waiting)
            Task { @MainActor [weak self] in
                guard let final = await host.final(group.machineId, ticket: ticket) else { return }
                self?.pending.subtract(waiting)
                later(Sorted(group.machineId, final, requested: waiting.map(\.id)))
            }
        }
        return all
    }

    /// Ask before deleting `keys` for good. One machine words the question; across several the
    /// count and whether running work stops are put together from each machine's answer.
    func askDelete(_ keys: [InboxKey], in host: any OrganizeHost) async {
        guard !keys.isEmpty else { return }
        var questions: [DeleteQuestion] = []
        for group in Self.byMachine(keys) {
            if let question = await host.deleteQuestion(group.machineId, group.ids) { questions.append(question) }
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

    /// The person confirmed: delete now, with no Undo. A thread counts as deleted only once its
    /// machine took the delete; one still waiting stays pending until it answers. Threads refused
    /// only because their agents or terminals still run are asked about again as one Stop and delete.
    func confirmDelete(_ ask: DeleteAsk, in host: any OrganizeHost) async {
        deleting = nil
        let sorted = await send(.delete, ask.keys, in: host, force: ask.question.force) { [weak self] later in
            self?.deleteAnswered(later)
        }
        deleteAnswered(sorted)
    }

    private func deleteAnswered(_ sorted: Sorted) {
        if !sorted.taken.isEmpty { deleted.formUnion(sorted.taken); feedback += 1 }
        report(sorted.refused.map(\.message), doing: "delete")
        guard !sorted.running.isEmpty, let retry = sorted.retry else { return }
        let question = sorted.running.count == 1 || deleting == nil ? retry : Self.combined([retry], count: sorted.running.count)
        deleting = DeleteAsk(keys: sorted.running, question: question)
    }

    /// One action on one thread or several, across machines. Settle and archive confirm with a
    /// toast offering Undo for the threads their machines took; ones still waiting are counted as
    /// pending in it and join its Undo once taken.
    func run(_ action: BulkAction, _ keys: [InboxKey], in host: any OrganizeHost) async {
        guard !keys.isEmpty else { return }
        if action == .delete { await askDelete(keys, in: host); return }
        // Settling clears a snooze; its Undo puts it back.
        var snoozes: [InboxKey: Double] = [:]
        if action == .settle { for key in keys { if let until = host.row(key)?.snoozedUntil { snoozes[key] = until } } }
        let verb = action == .settle ? "Settled" : "Archived"
        let kind: InboxUndo.Kind? = action == .settle ? .settled(snoozes: snoozes) : action == .archive ? .archived : nil
        var serial: UUID?
        var waitingLeft = 0
        let sorted = await send(action, keys, in: host) { [weak self] later in
            guard let self else { return }
            self.report(later.refused.map(\.message), doing: action.rawValue)
            // Taken after the toast went up: it joins that toast's Undo while it shows.
            waitingLeft = max(0, waitingLeft - later.taken.count - later.refused.count)
            guard let kind, let current = self.undo, current.serial == serial, !later.taken.isEmpty else { return }
            let keys = current.keys + later.taken
            var joined = InboxUndo(keys: keys, kind: kind, text: Self.toast(verb, done: keys.count, waiting: waitingLeft))
            joined.serial = current.serial
            self.undo = joined
        }
        report(sorted.refused.map(\.message), doing: action.rawValue)
        waitingLeft = sorted.waiting.count
        guard !sorted.taken.isEmpty || !sorted.waiting.isEmpty else { return }
        feedback += 1
        if let kind {
            let toast = InboxUndo(keys: sorted.taken, kind: kind, text: Self.toast(verb, done: sorted.taken.count, waiting: sorted.waiting.count))
            serial = toast.serial
            undo = toast
        }
    }

    /// Move `keys` (all on one machine) to `project`, with Undo back to where each was.
    func move(_ keys: [InboxKey], to project: ComposeProject, in host: any OrganizeHost) async {
        moving = nil
        var from: [InboxKey: String] = [:]
        for key in keys { if let workspace = host.row(key)?.workspaceId, workspace != project.id { from[key] = workspace } }
        guard !from.isEmpty else { return }
        let moving = keys.filter { from[$0] != nil }
        let sorted = await send(.move, moving, in: host, workspaceId: project.id) { [weak self] later in
            self?.report(later.refused.map(\.message), doing: "move")
        }
        report(sorted.refused.map(\.message), doing: "move")
        let moved = from.filter { sorted.taken.contains($0.key) }
        guard !moved.isEmpty || !sorted.waiting.isEmpty else { return }
        feedback += 1
        let pending = sorted.waiting.isEmpty ? "" : " · \(sorted.waiting.count) waiting"
        undo = InboxUndo(keys: Array(moved.keys), kind: .moved(from: moved),
                         text: (moved.count + sorted.waiting.count == 1 ? "Moved to \(project.name)" : "Moved \(moved.count + sorted.waiting.count) threads to \(project.name)") + pending)
    }

    /// Take back the toast's action, restoring what it changed. Resolves with whether every
    /// thread was put back; any its machine refused stay on the toast to try again, and the
    /// alert names them.
    func takeBack(_ undo: InboxUndo, in host: any OrganizeHost) async -> Bool {
        self.undo = nil
        var failed: [InboxKey] = []
        var reasons: [String] = []
        switch undo.kind {
        case .settled(let snoozes):
            let sorted = await send(.undoSettle, undo.keys, in: host)
            failed += sorted.refused.map(\.key); reasons += sorted.refused.map(\.message)
            // The snooze the settle cleared comes back, while it still has time to run.
            let now = host.clock()
            for key in sorted.taken + sorted.waiting {
                guard let until = snoozes[key], until > now else { continue }
                if await !host.snooze(key, until: until) { failed.append(key); reasons.append("Couldn't put its snooze back.") }
            }
        case .archived:
            let sorted = await send(.unarchive, undo.keys, in: host)
            failed += sorted.refused.map(\.key); reasons += sorted.refused.map(\.message)
        case .moved(let from):
            // One move per project they came from; moving back restores their details there.
            let byProject = Dictionary(grouping: undo.keys) { from[$0] ?? "" }
            for (workspace, keys) in byProject where !workspace.isEmpty {
                let sorted = await send(.move, keys, in: host, workspaceId: workspace)
                failed += sorted.refused.map(\.key); reasons += sorted.refused.map(\.message)
            }
        }
        guard !failed.isEmpty else { return true }
        let unique = Array(Set(failed))
        let titles = unique.compactMap { host.row($0)?.title }
        let names = titles.isEmpty ? "" : " (\(titles.prefix(3).joined(separator: ", ")))"
        problem = "Couldn't undo \(unique.count == 1 ? "1 thread" : "\(unique.count) threads")\(names). \(reasons.first ?? "")"
        // Still undoable: the toast stays with the threads that weren't put back.
        self.undo = InboxUndo(keys: unique, kind: undo.kind, text: "Couldn't undo \(unique.count == 1 ? "1 thread" : "\(unique.count) threads")")
        return false
    }

    private func report(_ refused: [String], doing verb: String) {
        guard let first = refused.first else { return }
        problem = refused.count == 1 ? first : "Couldn't \(verb) \(refused.count) threads. \(first)"
    }

    static func counted(_ verb: String, _ count: Int) -> String {
        count == 1 ? "\(verb) thread" : "\(verb) \(count) threads"
    }
    /// "Archived 2 threads · 1 waiting": what the machines took, and what still waits on them.
    static func toast(_ verb: String, done: Int, waiting: Int) -> String {
        let total = done + waiting
        return counted(verb, total) + (waiting > 0 ? " · \(waiting) waiting" : "")
    }
}

extension MachineInbox: OrganizeHost {
    func bulk(_ machineId: String, _ action: BulkAction, _ ids: [String], workspaceId: String?, force: Bool, ticket: String) async -> BulkOutcome {
        guard let client = client(machineId) else {
            return BulkOutcome(refused: ids.map { .init(threadId: $0, message: "That machine isn't paired any more.") })
        }
        return await client.bulk(action, ids, workspaceId: workspaceId, force: force, ticket: ticket)
    }
    func final(_ machineId: String, ticket: String) async -> BulkOutcome? {
        await client(machineId)?.bulkFinals.wait(ticket)
    }
    func snooze(_ key: InboxKey, until: Double?) async -> Bool {
        await client(key.machineId)?.snooze(key.id, until: until) == true
    }
    func deleteQuestion(_ machineId: String, _ ids: [String]) async -> DeleteQuestion? {
        await client(machineId)?.deleteQuestion(ids)
    }
}
