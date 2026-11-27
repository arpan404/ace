import Foundation
import OSLog
import WidgetKit

/// Keeps everything outside the app current: each machine's Live Activity (ADR 0223) and the
/// widgets' app-group snapshots. The notification coordinator calls `changed()` whenever any
/// machine's inbox or connection changes; work is coalesced, then the summary is rebuilt across
/// machines for the widgets and per machine for its activity (`LockScreenBuilder`), and sent
/// only where it changed.
@MainActor final class LockScreenHub {
    struct Edges {
        var activity: any MachineActivityPort
        var writeSnapshot: (LockSummary) -> Void
        /// Each machine's name, rows and `seq`, for its activity (`MachineSnapshotStore`).
        var writeMachines: ([MachineLockEntry]) -> Void = { _ in }
        var reloadWidgets: () -> Void
        var readSnapshot: () -> LockSummary? = { nil }
        /// How often a running activity is rebuilt while ace is open, so an unchanged inbox
        /// never reaches its stale date while it is still being confirmed. Nil: never.
        var renewal: Duration? = nil
        static var system: Edges {
            Edges(activity: SystemMachineActivity(), writeSnapshot: { LockSnapshotStore.write($0) },
                  writeMachines: { MachineSnapshotStore.write($0) },
                  reloadWidgets: { WidgetCenter.shared.reloadAllTimelines() },
                  readSnapshot: { LockSnapshotStore.read() }, renewal: .seconds(MachineActivityPlan.renewEvery))
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
    /// Per slot: what the app last wrote to the activity, and when.
    private var sent: [Int: (state: MachineActivityAttributes.ContentState, at: Date)] = [:]
    private var written: (summary: LockSummary, at: Date)?
    /// Per slot: the snapshot entry of each machine last seen connected.
    private var entries: [Int: MachineLockEntry] = [:]
    private var writtenEntries: [MachineLockEntry]?
    private var quietSince: [Int: Date] = [:]
    private var pending: Task<Void, Never>?
    /// Activity commits run one at a time, in order.
    private var commits: Task<Void, Never>?
    var foreground = true
    /// Settings › Notifications › Live Activity.
    var allowed = true
    /// Machines "Show on Lock Screen" asked for, started even while nothing runs there.
    private var shownByHand: Set<String> = []
    /// Tokens, or whether iOS allows activities, changed; the coordinator syncs every machine.
    var activityChanged: (@MainActor () -> Void)?

    init(edges: Edges, now: @escaping () -> Date, sleep: @escaping @Sendable (Duration) async -> Void) {
        self.edges = edges; self.now = now; self.sleep = sleep
        edges.activity.onChange = { [weak self] in self?.activityChanged?() }
    }

    /// The phone's Live Activity tokens, and what iOS allows, for each machine's sync.
    var tokens: LiveActivityTokens { edges.activity.tokens }
    var activitiesAllowed: Bool { allowed && edges.activity.systemAllowed }
    var frequentUpdates: Bool { edges.activity.frequentUpdates }

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
    /// Show a machine's activity now, from the thread menu.
    func show(hostId: String) throws {
        guard edges.activity.systemAllowed else { throw ServiceFailure(message: "Live Activities are off in iOS Settings.") }
        shownByHand.insert(hostId)
        rebuild()
    }
    /// A machine turned off or unpaired here: its activity goes at once, and its snapshot entry.
    func forget(slot: Int) {
        entries.removeValue(forKey: slot)
        sent.removeValue(forKey: slot)
        quietSince.removeValue(forKey: slot)
        let activity = edges.activity
        if let id = activity.shown(slot)?.id { enqueue { await activity.end(id, nil, dismissAt: .distantPast) } }
    }
    /// Drop the last confirmed summary kept for when no machine answers: what it showed may
    /// belong to a machine that is no longer to be shown.
    func forgetHeld() { lastLive = nil; restoredSnapshot = true }
    /// Rebuild at once; tests and the background refresh call it directly.
    func rebuild() {
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
        for machine in input.machines { drive(machine, requests: input.requests, at: at) }
        shownByHand = []
        writeMachines(input.machines.compactMap { $0.slot.flatMap { entries[$0] } })
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
        guard let renewal = edges.renewal, renewing == nil, foreground, !edges.activity.running.isEmpty else { return }
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

    private func writeMachines(_ next: [MachineLockEntry]) {
        guard next != writtenEntries else { return }
        writtenEntries = next
        edges.writeMachines(next)
    }

    /// One machine's activity. A machine out of reach tells nothing new: its activity keeps what
    /// it shows (its daemon's push may be newer) and ages to "as of" by itself; it never ends on
    /// a guess. A connected one's state is written with its rows, never below the `seq` shown.
    private func drive(_ machine: LockScreenBuilder.Machine, requests: [String: LockRequest], at: Date) {
        guard let slot = machine.slot else { return }
        let activity = edges.activity
        let permitted = allowed && activity.systemAllowed
        guard machine.online else {
            // Time out of reach proves nothing: the quiet grace starts again once it answers.
            quietSince[slot] = nil
            // Turned off here goes at once, reachable or not.
            if !permitted, activity.running.contains(slot) { forget(slot: slot) }
            return
        }
        let summary = LockScreenBuilder.summary([machine], requests: requests, now: at)
        let shown = activity.shown(slot)
        // Turned off here: it goes at once, busy or not, whoever drives it.
        guard permitted else {
            if shown != nil { forget(slot: slot) }
            return
        }
        if let shown, MachineActivityPlan.daemonDriven(shown.state) {
            return follow(machine, slot: slot, shown: shown, summary: summary, at: at)
        }
        quietSince[slot] = MachineActivityPlan.quietSince(summary, previous: quietSince[slot], now: at)
        var step = MachineActivityPlan.step(summary, running: shown != nil, allowed: permitted,
                                            foreground: foreground, quietSince: quietSince[slot], now: at)
        Self.log.debug("lock screen \(slot) \(String(describing: step), privacy: .public): \(summary.needsYou) need, \(summary.working) working, current \(summary.current)")
        // "Show on Lock Screen" starts it even while nothing runs; it ends like any quiet one.
        if step == .none, shownByHand.contains(machine.hostId), permitted, shown == nil { step = .start }
        let content = summary.limited(3)
        let seq = MachineActivityPlan.localSeq(shown: shown?.state, written: sent[slot]?.state.seq)
        let state = MachineActivityPlan.local(content, seq: seq, at: at)
        entries[slot] = MachineLockEntry(slot: slot, name: machine.name, seq: seq, rows: content.rows,
                                         request: summary.current ? content.request : nil, confirmed: summary.current)
        let stale = at.addingTimeInterval(MachineActivityPlan.staleAfter)
        switch step {
        case .none: return
        case .start:
            do { try activity.start(slot, state, staleDate: stale); sent[slot] = (state, at) }
            catch { Self.log.error("Live Activity didn't start: \(error.localizedDescription, privacy: .public)") }
        case .update:
            guard let shown, MachineActivityPlan.accepts(state, over: shown.state),
                  MachineActivityPlan.shouldSend(state, last: sent[slot]?.state, sentAt: sent[slot]?.at, now: at) else { return }
            sent[slot] = (state, at)
            enqueue { await activity.update(shown.id, state, staleDate: stale) }
        case .end:
            guard let shown else { return }
            sent[slot] = (state, at)
            let dismiss = at.addingTimeInterval(MachineActivityPlan.lingerAfterEnd)
            // Decided now, run later: by then a push or new work may have arrived, so it ends
            // only the activity it was decided for, and only if that one is still quiet.
            enqueue { [weak self] in
                guard let self, self.stillEnding(slot, id: shown.id, state: state) else { return }
                await activity.end(shown.id, state, dismissAt: dismiss)
            }
        }
    }
    /// A queued end still holds when it runs: the same activity shows the app's own count at
    /// no later `seq`, and the machine has stayed confirmed quiet for the whole grace.
    private func stillEnding(_ slot: Int, id: String, state: MachineActivityAttributes.ContentState) -> Bool {
        guard let shown = edges.activity.shown(slot), shown.id == id, !MachineActivityPlan.daemonDriven(shown.state),
              MachineActivityPlan.accepts(state, over: shown.state), let quiet = quietSince[slot] else { return false }
        return now().timeIntervalSince(quiet) >= MachineActivityPlan.quietGrace
    }
    /// The daemon drives this activity: its counts, phase and times stay, and only it ends it. Rows join only beside the `seq` the socket
    /// confirmed; until then the snapshot holds nothing for it, so the widget shows counts alone.
    private func follow(_ machine: LockScreenBuilder.Machine, slot: Int, shown: ShownActivity,
                        summary: LockSummary, at: Date) {
        quietSince[slot] = nil
        let content = summary.limited(3)
        guard let next = MachineActivityPlan.withRows(shown.state, rows: content.rows, confirmedSeq: machine.daemonSeq) else {
            entries.removeValue(forKey: slot)
            return
        }
        entries[slot] = MachineLockEntry(slot: slot, name: machine.name, seq: shown.state.seq, rows: content.rows,
                                         request: summary.current ? content.request : nil, confirmed: summary.current)
        guard next != shown.state else { return }
        let activity = edges.activity
        let stale = at.addingTimeInterval(MachineActivityPlan.staleAfter)
        sent[slot] = (next, at)
        enqueue { await activity.update(shown.id, next, staleDate: stale) }
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
@MainActor final class InertActivity: MachineActivityPort {
    var systemAllowed: Bool { false }
    var frequentUpdates: Bool { false }
    var tokens: LiveActivityTokens { LiveActivityTokens() }
    var onChange: (@MainActor () -> Void)?
    var running: Set<Int> { [] }
    func shown(_ slot: Int) -> ShownActivity? { nil }
    func start(_ slot: Int, _ state: MachineActivityAttributes.ContentState, staleDate: Date) throws {}
    func update(_ id: String, _ state: MachineActivityAttributes.ContentState, staleDate: Date) async {}
    func end(_ id: String, _ state: MachineActivityAttributes.ContentState?, dismissAt: Date) async {}
}
