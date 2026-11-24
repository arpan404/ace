import Foundation
import OSLog
import WidgetKit

/// Rebuilds the widgets’ combined summary and drives each machine’s separate Live Activity.
@MainActor final class LockScreenHub {
    struct Edges {
        var activity: any AgentsActivityPort
        var writeSnapshot: (LockSummary) -> Void
        var reloadWidgets: () -> Void
        var writeMachineSnapshot: (MachineActivitySnapshot?, Int) -> Void = { _, _ in }
        var readSnapshot: () -> LockSummary? = { nil }
        /// How often a running activity is rebuilt while ace is open, so an unchanged inbox
        /// never reaches its stale date while it is still being confirmed. Nil: never.
        var renewal: Duration? = nil
        @MainActor static var system: Edges {
            Edges(activity: SystemAgentsActivity(), writeSnapshot: { LockSnapshotStore.write($0) },
                  reloadWidgets: { WidgetCenter.shared.reloadAllTimelines() },
                  writeMachineSnapshot: { MachineActivitySnapshot.write($0, slot: $1) },
                  readSnapshot: { LockSnapshotStore.read() }, renewal: .seconds(AgentsActivityPlan.renewEvery))
        }
        /// Touches nothing outside the process: the default where no app runs (tests, previews).
        static var inert: Edges { Edges(activity: InertActivity(), writeSnapshot: { _ in }, reloadWidgets: {}) }
    }
    /// How long a burst of inbox changes is gathered into one rebuild.
    static let coalesce: Duration = .milliseconds(300)
    /// An unchanged snapshot is rewritten this often, so the widgets' "as of" time moves on.
    static let snapshotRenewal: TimeInterval = 60
    private static let log = Logger(subsystem: "app.ace.ios", category: "lockScreen")

    private let edges: Edges
    private let now: () -> Date
    private let sleep: @Sendable (Duration) async -> Void
    private var renewing: Task<Void, Never>?
    /// The last summary a connected machine confirmed: what stays up, "as of" its time, once
    /// no machine answers (the phone offline, or the app letting its connections go).
    private var lastLive: LockSummary?
    private var restoredSnapshot = false
    typealias Input = (machines: [LockScreenBuilder.Machine], requests: [String: LockRequest])
    /// Reads every attached machine's rows and the approvals it was told about.
    var read: @MainActor () -> Input = { ([], [:]) }
    private(set) var summary: LockSummary = .empty
    private struct LocalActivity {
        var id: String
        var summary: LockSummary
        var at: Date
        var seq: Int
    }

    private var sent: [Int: LocalActivity] = [:]
    private var quietSince: [Int: Date] = [:]
    private var previouslyActive: Set<Int> = []
    private var dismissed: Set<Int> = []
    private var slots: [String: Int]
    private let defaults: UserDefaults?
    private static let slotsKey = "ace.lockScreen.machineSlots"
    var name: (String) -> String? = { _ in nil }
    var onActivityChange: () -> Void = {}
    private var written: (summary: LockSummary, at: Date)?
    private var pending: Task<Void, Never>?
    /// Activity commits run one at a time, in order.
    private var commits: Task<Void, Never>?
    var foreground = true
    /// Settings › Notifications › Live Activity.
    var allowed = true

    init(edges: Edges, now: @escaping () -> Date, sleep: @escaping @Sendable (Duration) async -> Void,
         defaults: UserDefaults? = nil) {
        self.edges = edges; self.now = now; self.sleep = sleep; self.defaults = defaults
        let saved = defaults?.dictionary(forKey: Self.slotsKey) as? [String: Int] ?? [:]
        var restored: [String: Int] = [:]
        for (host, slot) in saved.sorted(by: { $0.key < $1.key }) where (0..<16).contains(slot) {
            if !restored.values.contains(slot) { restored[host] = slot }
        }
        slots = restored
    }

    func observeActivities() {
        edges.activity.observe { [weak self] in
            guard let self else { return }
            self.changed()
            self.onActivityChange()
        }
    }

    @discardableResult func slot(for hostId: String) -> Int? {
        if let slot = slots[hostId] { return slot }
        let occupied = Set(slots.values).union(edges.activity.slots)
        guard let slot = (0..<16).first(where: { !occupied.contains($0) }) else { return nil }
        slots[hostId] = slot
        defaults?.set(slots, forKey: Self.slotsKey)
        return slot
    }

    func registration(for hostId: String) -> [String: Any]? {
        let activity = edges.activity
        guard allowed, activity.systemAllowed, let slot = slots[hostId] else { return nil }
        let start = activity.startToken
        let update = activity.current(slot: slot)?.token
        guard start != nil || update != nil else { return nil }
        var json: [String: Any] = ["slot": slot, "environment": PushRegistration.Environment.current.rawValue,
                                   "frequentUpdates": activity.frequentUpdates]
        json["startToken"] = start.map(PushRegistration.hex)
        json["activityToken"] = update.map(PushRegistration.hex)
        return json
    }

    func forgetActivity(for hostId: String) {
        guard let slot = slots[hostId] else { return }
        dismiss(slot: slot)
        dismissed.remove(slot)
    }

    func retireSlot(for hostId: String) {
        forgetActivity(for: hostId)
        slots[hostId] = nil
        defaults?.set(slots, forKey: Self.slotsKey)
    }

    private func dismiss(slot: Int) {
        edges.writeMachineSnapshot(nil, slot)
        sent[slot] = nil
        quietSince[slot] = nil
        previouslyActive.remove(slot)
        let activity = edges.activity
        guard let id = activity.current(slot: slot)?.id else { return }
        enqueue { await activity.end(slot: slot, id: id, nil, dismissAt: nil) }
    }

    /// Something changed somewhere; rebuild once the burst settles.
    func changed() {
        guard pending == nil else { return }
        pending = Task { @MainActor [weak self, sleep] in
            await sleep(Self.coalesce)
            guard !Task.isCancelled else { return }
            self?.pending = nil
            self?.rebuild()
        }
    }
    /// Show the activity now, from the thread menu.
    func show(hostId: String) throws {
        guard allowed, edges.activity.systemAllowed else { throw ServiceFailure(message: "Live Activities are off in Settings.") }
        guard let slot = slot(for: hostId) else { throw ServiceFailure(message: "All Live Activity slots are in use.") }
        dismissed.remove(slot)
        rebuild(showing: hostId)
    }
    /// Drop the last confirmed summary kept for when no machine answers: what it showed may
    /// belong to a machine that is no longer to be shown.
    func forgetHeld() { lastLive = nil; restoredSnapshot = true }
    /// Rebuild at once; tests and the background refresh call it directly.
    func rebuild(showing: String? = nil) {
        pending?.cancel()
        pending = nil
        if !restoredSnapshot {
            restoredSnapshot = true
            lastLive = edges.readSnapshot()
        }
        let at = now()
        let input = read()
        let next = Self.held(LockScreenBuilder.summary(input.machines, requests: input.requests, now: at), last: &lastLive)
        summary = next
        writeSnapshot(next, at: at)
        if allowed, edges.activity.systemAllowed {
            for slot in edges.activity.slots.subtracting(Set(slots.values)) { dismiss(slot: slot) }
            for machine in input.machines {
                guard let slot = slot(for: machine.hostId) else { continue }
                let local = LockScreenBuilder.summary([machine], requests: input.requests, now: at)
                drive(local, host: machine.hostId, slot: slot, at: at, manual: machine.hostId == showing)
            }
        } else {
            for slot in edges.activity.slots { dismiss(slot: slot) }
        }
        renew()
    }

    /// With no machine answering, the last confirmed counts stay, marked as the last known (so
    /// every surface says "as of" their time, with no running times and no Allow or Deny) rather
    /// than blanking to "Open ace to check" or claiming they are current.
    static func held(_ next: LockSummary, last: inout LockSummary?) -> LockSummary {
        if next.live { last = next; return next }
        guard var kept = last else { return next }
        kept.live = false
        kept.current = false
        kept.request = nil
        kept.busy = true
        return kept
    }

    /// While the activity runs and ace is open, rebuild every `renewal` so its stale date keeps
    /// moving with confirmed content; once ace leaves, it ages to "as of" by itself.
    private func renew() {
        guard let renewal = edges.renewal, renewing == nil, foreground, !edges.activity.slots.isEmpty else { return }
        renewing = Task { @MainActor [weak self, sleep] in
            await sleep(renewal)
            guard let self else { return }
            self.renewing = nil
            if self.foreground { self.rebuild() }
        }
    }

    private func writeSnapshot(_ next: LockSummary, at: Date) {
        let changed = written.map { !next.sameContent(as: $0.summary) } ?? true
        guard changed || at.timeIntervalSince(written?.at ?? .distantPast) >= Self.snapshotRenewal else { return }
        written = (next, at)
        edges.writeSnapshot(next)
        if changed { edges.reloadWidgets() }
    }

    private func drive(_ next: LockSummary, host: String, slot: Int, at: Date, manual: Bool) {
        let activity = edges.activity
        let current = activity.current(slot: slot)
        if current != nil { previouslyActive.insert(slot) }
        else if previouslyActive.remove(slot) != nil { dismissed.insert(slot) }

        if next.current, !next.busy {
            quietSince[slot] = quietSince[slot] ?? at
            dismissed.remove(slot)
        } else {
            quietSince[slot] = nil
        }

        // The base daemon has no sequenced socket state. The local fallback uses negative
        // sequences and leaves all daemon content (nonnegative sequences) to ActivityKit.
        guard current.map({ $0.state.seq < 0 }) ?? true, next.current else { return }
        let canStart = foreground && (manual || (next.busy && next.current && !dismissed.contains(slot)))
        guard current != nil || canStart else { return }
        let settled = current != nil && (quietSince[slot].map { at.timeIntervalSince($0) >= AgentsActivityPlan.quietGrace } ?? false)
        let last = sent[slot]
        if !settled, let current, let last, last.id == current.id, next.sameContent(as: last.summary),
           at.timeIntervalSince(last.at) < AgentsActivityPlan.renewEvery { return }

        // A distinct sequence ties a snapshot to its exact update, including two changes in
        // the same millisecond. The negative range keeps every state below the daemon's.
        let lastSequence = max(current?.state.seq ?? Int.min, last?.seq ?? Int.min)
        let seq = max(Int(at.timeIntervalSince1970 * 1000) - 8_000_000_000_000_000, lastSequence + 1)
        let state = MachineActivityState(next, seq: seq, settled: settled)
        let snapshot = MachineActivitySnapshot(seq: seq, name: String((name(host) ?? "ace").prefix(256)),
                                               rows: Array(next.rows.prefix(3)), request: next.request)
        let stale = at.addingTimeInterval(LockSummary.freshFor)
        if let current {
            sent[slot] = LocalActivity(id: current.id, summary: next, at: at, seq: seq)
            enqueue { [weak self] in
                guard let self, self.allowed, activity.systemAllowed,
                      let latest = activity.current(slot: slot), latest.id == current.id,
                      latest.state.acceptsLocalUpdate(state) else { return }
                if settled {
                    guard self.quietSince[slot] != nil, self.sent[slot]?.seq == seq else { return }
                }
                self.edges.writeMachineSnapshot(snapshot, slot)
                if settled {
                    await activity.end(slot: slot, id: current.id, state, dismissAt: at.addingTimeInterval(AgentsActivityPlan.lingerAfterEnd))
                } else {
                    await activity.update(slot: slot, id: current.id, state, staleDate: stale)
                }
            }
        } else {
            do {
                try activity.start(slot: slot, state, staleDate: stale)
                if let started = activity.current(slot: slot), started.state.seq == seq {
                    previouslyActive.insert(slot)
                    sent[slot] = LocalActivity(id: started.id, summary: next, at: at, seq: seq)
                    edges.writeMachineSnapshot(snapshot, slot)
                }
            } catch {
                Self.log.error("Live Activity didn’t start: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = commits
        commits = Task { @MainActor in
            await previous?.value
            await work()
        }
    }
    /// Waits for queued activity commits; tests use it.
    func settle() async { await commits?.value }
}

/// An activity port that never shows anything.
@MainActor final class InertActivity: AgentsActivityPort {
    var systemAllowed: Bool { false }
    var frequentUpdates: Bool { false }
    var startToken: Data? { nil }
    var slots: Set<Int> { [] }
    func current(slot: Int) -> (id: String, state: MachineActivityState, token: Data?)? { nil }
    func observe(_ changed: @escaping @MainActor () -> Void) {}
    func start(slot: Int, _ state: MachineActivityState, staleDate: Date) throws {}
    func update(slot: Int, id: String, _ state: MachineActivityState, staleDate: Date) async {}
    func end(slot: Int, id: String, _ state: MachineActivityState?, dismissAt: Date?) async {}
}
