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
    /// An Undo still waiting on a machine: the toast says so and offers nothing until it answers.
    var busy = false

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
    /// nil once the machine took it, else its refusal in words.
    func snooze(_ key: InboxKey, until: Double?) async -> String?
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
    /// Each waiting thread's command: whether its machine took it, once it answers.
    @ObservationIgnored private var landings: [InboxKey: Landing] = [:]

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
            let signals = Dictionary(uniqueKeysWithValues: waiting.map { ($0, Landing()) })
            landings.merge(signals) { _, new in new }
            Task { @MainActor [weak self] in
                // A machine that goes away first leaves them pending, and an Undo waiting on them.
                guard let final = await host.final(group.machineId, ticket: ticket) else { return }
                let answered = Sorted(group.machineId, final, requested: waiting.map(\.id))
                self?.pending.subtract(waiting)
                for (key, signal) in signals {
                    signal.settle(answered.taken.contains(key))
                    if self?.landings[key] === signal { self?.landings[key] = nil }
                }
                later(answered)
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
        let toast = PendingToast(verb: verb)
        let sorted = await send(action, keys, in: host) { [weak self] later in
            self?.report(later.refused.map(\.message), doing: action.rawValue)
            self?.answered(toast, later)
        }
        report(sorted.refused.map(\.message), doing: action.rawValue)
        guard !sorted.taken.isEmpty || !sorted.waiting.isEmpty else { return }
        feedback += 1
        guard let kind else { return }
        // Undo covers the waiting threads too: theirs goes out once their own command lands.
        show(toast, InboxUndo(keys: sorted.taken + sorted.waiting, kind: kind, text: ""), waiting: sorted.waiting)
    }

    /// Move `keys` (all on one machine) to `project`, with Undo back to where each was.
    func move(_ keys: [InboxKey], to project: ComposeProject, in host: any OrganizeHost) async {
        moving = nil
        var from: [InboxKey: String] = [:]
        for key in keys { if let workspace = host.row(key)?.workspaceId, workspace != project.id { from[key] = workspace } }
        guard !from.isEmpty else { return }
        let moving = keys.filter { from[$0] != nil }
        let toast = PendingToast(verb: "Moved", suffix: " to \(project.name)")
        let sorted = await send(.move, moving, in: host, workspaceId: project.id) { [weak self] later in
            self?.report(later.refused.map(\.message), doing: "move")
            self?.answered(toast, later)
        }
        report(sorted.refused.map(\.message), doing: "move")
        let covered = sorted.taken + sorted.waiting
        guard !covered.isEmpty else { return }
        feedback += 1
        show(toast, InboxUndo(keys: covered, kind: .moved(from: from.filter { covered.contains($0.key) }), text: ""), waiting: sorted.waiting)
    }

    /// The toast of one action whose threads may still be waiting on their machines.
    private final class PendingToast {
        let verb: String
        let suffix: String
        var serial: UUID?
        var waiting: Set<InboxKey> = []
        init(verb: String, suffix: String = "") { self.verb = verb; self.suffix = suffix }
        func text(_ count: Int) -> String {
            let words = count == 1 ? "\(verb) thread\(suffix)" : "\(verb) \(count) threads\(suffix)"
            return words + (waiting.isEmpty ? "" : " · \(waiting.count) waiting")
        }
    }
    private func show(_ toast: PendingToast, _ undo: InboxUndo, waiting: [InboxKey]) {
        toast.waiting = Set(waiting)
        let shown = InboxUndo(keys: undo.keys, kind: undo.kind, text: toast.text(undo.keys.count))
        toast.serial = shown.serial
        self.undo = shown
    }
    /// A late answer: refused threads leave the toast's Undo, and its count of waiting ones drops.
    private func answered(_ toast: PendingToast, _ later: Sorted) {
        toast.waiting.subtract(later.taken + later.refused.map(\.key) + later.running)
        guard let current = undo, current.serial == toast.serial else { return }
        let refused = Set(later.refused.map(\.key) + later.running)
        let keys = current.keys.filter { !refused.contains($0) }
        guard !keys.isEmpty else { undo = nil; return }
        var kept = InboxUndo(keys: keys, kind: current.kind, text: toast.text(keys.count))
        kept.serial = current.serial
        undo = kept
    }

    /// Take back the toast's action, restoring what it changed. A thread whose own command is
    /// still waiting is put back once that lands. Resolves true only once every thread is back;
    /// while any waits the toast says so, and any its machine refused stay on it to try again.
    func takeBack(_ undo: InboxUndo, in host: any OrganizeHost) async -> Bool {
        var busy = InboxUndo(keys: undo.keys, kind: undo.kind, text: "Undoing…")
        busy.busy = true
        self.undo = busy
        let serial = busy.serial
        // Only threads whose action their machine took have anything to put back.
        var landed: [InboxKey] = []
        for key in undo.keys {
            if let landing = landings[key] { if await landing.wait() { landed.append(key) } } else { landed.append(key) }
        }
        let outcome = UndoOutcome()
        let finish = { [weak self] in self?.undoAnswered(undo, outcome, serial: serial, host: host) }
        switch undo.kind {
        case .settled(let snoozes):
            let sorted = await send(.undoSettle, landed, in: host) { [weak self] later in
                outcome.record(later)
                Task { @MainActor in
                    await self?.putSnoozesBack(later.taken, snoozes, outcome, host: host)
                    finish()
                }
            }
            outcome.record(sorted)
            await putSnoozesBack(sorted.taken, snoozes, outcome, host: host)
        case .archived:
            let sorted = await send(.unarchive, landed, in: host) { later in outcome.record(later); finish() }
            outcome.record(sorted)
        case .moved(let from):
            // One move per project they came from; moving back restores their links there.
            let byProject = Dictionary(grouping: landed) { from[$0] ?? "" }
            for (workspace, keys) in byProject where !workspace.isEmpty {
                let sorted = await send(.move, keys, in: host, workspaceId: workspace) { later in outcome.record(later); finish() }
                outcome.record(sorted)
            }
        }
        return undoAnswered(undo, outcome, serial: serial, host: host)
    }

    /// Where an Undo stands: done only once nothing waits and nothing failed.
    @discardableResult private func undoAnswered(_ undo: InboxUndo, _ outcome: UndoOutcome, serial: UUID, host: any OrganizeHost) -> Bool {
        guard self.undo?.serial == serial else { return outcome.done }
        if !outcome.waiting.isEmpty {
            var busy = InboxUndo(keys: undo.keys, kind: undo.kind, text: "Undoing · \(outcome.waiting.count) waiting")
            busy.busy = true
            busy.serial = serial
            self.undo = busy
            return false
        }
        guard !outcome.failed.isEmpty else { self.undo = nil; return true }
        let failed = outcome.failed.map(\.key)
        let titles = failed.compactMap { host.row($0)?.title }
        let names = titles.isEmpty ? "" : " (\(titles.prefix(3).joined(separator: ", ")))"
        let count = failed.count == 1 ? "1 thread" : "\(failed.count) threads"
        problem = "Couldn't undo \(count)\(names). \(outcome.failed.first?.message ?? "")"
        // Still undoable: the toast stays with the threads that weren't put back.
        var retry = InboxUndo(keys: failed, kind: undo.kind, text: "Couldn't undo \(count)")
        retry.serial = serial
        self.undo = retry
        return false
    }

    /// The snooze a settle cleared comes back, while it still has time to run.
    private func putSnoozesBack(_ keys: [InboxKey], _ snoozes: [InboxKey: Double], _ outcome: UndoOutcome, host: any OrganizeHost) async {
        let now = host.clock()
        for key in keys {
            guard let until = snoozes[key], until > now else { continue }
            if let refusal = await host.snooze(key, until: until) { outcome.fail(key, "Couldn't put its snooze back. \(refusal)") }
        }
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
    func snooze(_ key: InboxKey, until: Double?) async -> String? {
        guard let client = client(key.machineId) else { return "That machine isn't paired any more." }
        return await client.snooze(key.id, until: until)
    }
    func deleteQuestion(_ machineId: String, _ ids: [String]) async -> DeleteQuestion? {
        await client(machineId)?.deleteQuestion(ids)
    }
}

/// Whether one waiting thread's command landed: Undo waits on it before putting the thread back.
@MainActor final class Landing {
    private var taken: Bool?
    private var waiters: [CheckedContinuation<Bool, Never>] = []
    func settle(_ taken: Bool) {
        guard self.taken == nil else { return }
        self.taken = taken
        for waiter in waiters { waiter.resume(returning: taken) }
        waiters = []
    }
    func wait() async -> Bool {
        if let taken { return taken }
        return await withCheckedContinuation { waiters.append($0) }
    }
}

/// An Undo's answers so far: which threads still wait on their machines, and which failed.
@MainActor final class UndoOutcome {
    private(set) var waiting: Set<InboxKey> = []
    private(set) var failed: [(key: InboxKey, message: String)] = []
    var done: Bool { waiting.isEmpty && failed.isEmpty }
    func record(_ sorted: InboxOrganize.Sorted) {
        waiting.formUnion(sorted.waiting)
        waiting.subtract(sorted.taken)
        for refusal in sorted.refused { waiting.remove(refusal.key); failed.append(refusal) }
        for key in sorted.running { waiting.remove(key); failed.append((key, "Still running.")) }
    }
    func fail(_ key: InboxKey, _ message: String) { failed.append((key, message)) }
}
