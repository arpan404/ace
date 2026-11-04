import Foundation
import OSLog
import WidgetKit

/// Keeps everything outside the app current: the one agents Live Activity and the widgets'
/// app-group snapshot. The notification coordinator calls `changed()` whenever any machine's
/// inbox or connection changes; work is coalesced, then the summary is rebuilt across machines
/// (`LockScreenBuilder`) and sent only where it changed.
@MainActor final class LockScreenHub {
    struct Edges {
        var activity: any AgentsActivityPort
        var writeSnapshot: (LockSummary) -> Void
        var reloadWidgets: () -> Void
        static var system: Edges {
            Edges(activity: SystemAgentsActivity(), writeSnapshot: { LockSnapshotStore.write($0) },
                  reloadWidgets: { WidgetCenter.shared.reloadAllTimelines() })
        }
        /// Touches nothing outside the process: the default where no app runs (tests, previews).
        static var inert: Edges { Edges(activity: InertActivity(), writeSnapshot: { _ in }, reloadWidgets: {}) }
    }
    /// How long a burst of inbox changes is gathered into one rebuild.
    static let coalesce: Duration = .milliseconds(300)
    /// An unchanged snapshot is rewritten this often, so the widgets' "as of" time moves on.
    static let snapshotRenewal: TimeInterval = 5 * 60
    private static let log = Logger(subsystem: "app.ace.ios", category: "lockScreen")

    private let edges: Edges
    private let now: () -> Date
    private let sleep: @Sendable (Duration) async -> Void
    typealias Input = (machines: [LockScreenBuilder.Machine], requests: [String: LockRequest])
    /// Reads every attached machine's rows and the approvals it was told about.
    var read: @MainActor () -> Input = { ([], [:]) }
    private(set) var summary: LockSummary = .empty
    private var sent: (summary: LockSummary, at: Date)?
    private var written: (summary: LockSummary, at: Date)?
    private var quietSince: Date?
    private var pending: Task<Void, Never>?
    /// Activity commits run one at a time, in order.
    private var commits: Task<Void, Never>?
    var foreground = true
    /// Settings › Notifications › Live Activity.
    var allowed = true
    /// Held on by "Show on Lock Screen" even while nothing runs, until the next quiet end.
    private var shownByHand = false

    init(edges: Edges, now: @escaping () -> Date, sleep: @escaping @Sendable (Duration) async -> Void) {
        self.edges = edges; self.now = now; self.sleep = sleep
    }

    /// Something changed somewhere; rebuild once the burst settles.
    func changed() {
        guard pending == nil else { return }
        pending = Task { @MainActor [weak self, sleep] in
            await sleep(Self.coalesce)
            self?.pending = nil
            self?.rebuild()
        }
    }
    /// Show the activity now, from the thread menu.
    func show() throws {
        guard edges.activity.systemAllowed else { throw ServiceFailure(message: "Live Activities are off in iOS Settings.") }
        shownByHand = true
        rebuild()
    }
    /// Rebuild at once; tests and the background refresh call it directly.
    func rebuild() {
        let at = now()
        let input = read()
        let next = LockScreenBuilder.summary(input.machines, requests: input.requests, now: at)
        summary = next
        writeSnapshot(next, at: at)
        drive(next, at: at)
    }

    private func writeSnapshot(_ next: LockSummary, at: Date) {
        let changed = written.map { !next.sameContent(as: $0.summary) } ?? true
        guard changed || at.timeIntervalSince(written?.at ?? .distantPast) >= Self.snapshotRenewal else { return }
        written = (next, at)
        edges.writeSnapshot(next)
        if changed { edges.reloadWidgets() }
    }

    private func drive(_ next: LockSummary, at: Date) {
        quietSince = AgentsActivityPlan.quietSince(next, previous: quietSince, now: at)
        let activity = edges.activity
        let permitted = allowed && activity.systemAllowed
        var step = AgentsActivityPlan.step(next, running: activity.running, allowed: permitted,
                                           foreground: foreground, quietSince: quietSince, now: at)
        Self.log.debug("lock screen \(String(describing: step), privacy: .public): \(next.needsYou) need, \(next.working) working, current \(next.current)")
        // "Show on Lock Screen" starts it even while nothing runs; it ends like any quiet one.
        if step == .none, shownByHand, permitted, !activity.running { step = .start }
        shownByHand = false
        let content = next.limited(3)
        let stale = at.addingTimeInterval(AgentsActivityPlan.staleAfter)
        switch step {
        case .none: return
        case .start:
            do { try activity.start(content, staleDate: stale); sent = (content, at) }
            catch { Self.log.error("Live Activity didn't start: \(error.localizedDescription, privacy: .public)") }
        case .update:
            guard AgentsActivityPlan.shouldSend(content, last: sent?.summary, sentAt: sent?.at, now: at) else { return }
            sent = (content, at)
            enqueue { await activity.update(content, staleDate: stale) }
        case .end:
            sent = nil
            let dismiss = at.addingTimeInterval(AgentsActivityPlan.lingerAfterEnd)
            enqueue { await activity.end(content, dismissAt: dismiss) }
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
    var running: Bool { false }
    func start(_ summary: LockSummary, staleDate: Date) throws {}
    func update(_ summary: LockSummary, staleDate: Date) async {}
    func end(_ summary: LockSummary, dismissAt: Date) async {}
}
