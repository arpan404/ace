import ActivityKit
import Foundation

/// When the one Live Activity for the person's agents starts, updates and ends. Pure, so the
/// rules are tested without ActivityKit.
///
/// It starts when something works, waits or needs the person (iOS lets an app start one only
/// while it is open), updates while it runs, and ends only after everything has been confirmed
/// quiet on every machine for `quietGrace`. A machine that can't be reached, or rows its machine
/// hasn't confirmed, count as busy: the activity never ends, and never says done, on a guess.
enum AgentsActivityPlan {
    enum Step: Equatable, Sendable { case none, start, update, end }

    /// How long everything must stay quiet before the activity goes.
    static let quietGrace: TimeInterval = 120
    /// How long a quiet last state stays on the Lock Screen after it ends.
    static let lingerAfterEnd: TimeInterval = 15 * 60
    /// How long content counts as current. Past it the activity says to open ace; updates arrive
    /// only while ace runs (open, or refreshing in the background) until push updates exist.
    static let staleAfter = LockSummary.freshFor
    /// An unchanged summary is re-sent this often while ace runs, so its stale date moves on.
    static let renewEvery: TimeInterval = 60

    static func step(_ summary: LockSummary, running: Bool, allowed: Bool, foreground: Bool,
                     quietSince: Date?, now: Date) -> Step {
        guard allowed else { return running ? .end : .none }
        if summary.busy { return running ? .update : foreground ? .start : .none }
        guard running else { return .none }
        if let quietSince, now.timeIntervalSince(quietSince) >= quietGrace { return .end }
        return .update
    }
    /// When quiet began: kept while quiet, cleared by anything busy.
    static func quietSince(_ summary: LockSummary, previous: Date?, now: Date) -> Date? {
        summary.busy ? nil : previous ?? now
    }
    /// Whether to send `summary` now: changed content goes at once; the same content only once
    /// `renewEvery` has passed since it was last sent.
    static func shouldSend(_ summary: LockSummary, last: LockSummary?, sentAt: Date?, now: Date) -> Bool {
        guard let last, let sentAt, summary.sameContent(as: last) else { return true }
        return now.timeIntervalSince(sentAt) >= renewEvery
    }
}

/// The ActivityKit edge, substituted in tests.
@MainActor protocol AgentsActivityPort: AnyObject {
    /// Live Activities are allowed in iOS Settings.
    var systemAllowed: Bool { get }
    /// An agents activity is on the Lock Screen (active or stale).
    var running: Bool { get }
    func start(_ summary: LockSummary, staleDate: Date) throws
    func update(_ summary: LockSummary, staleDate: Date) async
    func end(_ summary: LockSummary, dismissAt: Date) async
}

/// The real ActivityKit activity. Local updates only (`pushType: nil`): the content is plain JSON
/// (`LockSummary`), so a push through ace's gateway can update it once the daemon sends one.
@MainActor final class SystemAgentsActivity: AgentsActivityPort {
    var systemAllowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var running: Bool { !live.isEmpty }
    private var live: [Activity<AgentsActivityAttributes>] {
        Activity<AgentsActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }
    func start(_ summary: LockSummary, staleDate: Date) throws {
        _ = try Activity.request(attributes: AgentsActivityAttributes(), content: ActivityContent(state: summary, staleDate: staleDate), pushType: nil)
        Self.endOlderActivities()
    }
    func update(_ summary: LockSummary, staleDate: Date) async {
        // One activity at most: extras (a race between two starts) end.
        let all = live
        for (index, activity) in all.enumerated() {
            nonisolated(unsafe) let target = activity
            if index == 0 { await target.update(ActivityContent(state: summary, staleDate: staleDate)) }
            else { await target.end(nil, dismissalPolicy: .immediate) }
        }
    }
    func end(_ summary: LockSummary, dismissAt: Date) async {
        for activity in live {
            nonisolated(unsafe) let target = activity
            await target.end(ActivityContent(state: summary, staleDate: nil), dismissalPolicy: .after(dismissAt))
        }
    }
    /// Builds before this one started an activity per thread; the agents activity replaces them.
    static func endOlderActivities() {
        for activity in Activity<ThreadActivityAttributes>.activities {
            nonisolated(unsafe) let target = activity
            Task { await target.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
