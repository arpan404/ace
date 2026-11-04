import Foundation
import Testing
@testable import Ace

/// The lock screen across machines: what the summary counts and shows, when the one Live
/// Activity starts and ends, and that nothing reads as quiet or done while any machine's state
/// can't be confirmed.
@Suite @MainActor struct LockScreenTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func theSummaryCountsWhatNeedsThePersonAndWhatWorksAcrossMachinesMostUrgentFirst() throws {
        let summary = LockScreenBuilder.summary([
            .init(hostId: "studio", rows: [try row("a", level: "active", icon: "working", since: 100),
                                          try row("b", level: "quiet", icon: "none")], online: true),
            .init(hostId: "laptop", rows: [try row("c", level: "needs-you", icon: "approve"),
                                          try row("d", level: "done-unread", icon: "done"),
                                          try row("e", level: "active", icon: "agents", since: 50)], online: true),
        ], requests: [:], now: t0)
        #expect(summary.headline == "1 needs you · 2 working")
        #expect(summary.current && summary.busy)
        // Needs you, then the longest-running work, then results; quiet rows don't show.
        #expect(summary.rows.map(\.id) == ["c", "e", "a", "d"])
        #expect(summary.rows.first?.link == "ace://thread/c?machine=laptop")
        #expect(summary.rows.first { $0.id == "a" }?.since == Date(timeIntervalSince1970: 0.1))
    }

    @Test func aMachineOutOfReachOrARowItHasntConfirmedKeepsTheSummaryOpenAndNeverQuiet() throws {
        let offline = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "done-unread", icon: "done")], online: false)],
                                                requests: [:], now: t0)
        #expect(!offline.current && offline.busy)
        #expect(offline.headline == "Open ace to check")
        let unconfirmed = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "quiet", icon: "none", confirmed: false)], online: true)],
                                                    requests: [:], now: t0)
        #expect(!unconfirmed.current && unconfirmed.busy)
        #expect(unconfirmed.headline != "Nothing needs you")
        let quiet = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "quiet", icon: "none")], online: true)],
                                              requests: [:], now: t0)
        #expect(quiet.current && !quiet.busy)
        #expect(quiet.headline == "Nothing needs you")
    }

    @Test func anApprovalOffersAllowAndDenyOnlyWhileItsThreadStillNeedsThePerson() throws {
        let request = LockRequest(hostId: "studio", threadId: "a", interactionId: "push", approve: "allow", deny: "deny",
                                  sentence: "Claude Code wants to run a command", detail: "bun run test", code: true, title: "Fix")
        let requests = [LockScreenBuilder.key(host: "studio", thread: "a"): request]
        let waiting = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "needs-you", icon: "approve")], online: true)],
                                                requests: requests, now: t0)
        #expect(waiting.request == request)
        let movedOn = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "active", icon: "working")], online: true)],
                                                requests: requests, now: t0)
        #expect(movedOn.request == nil)
    }

    @Test func theActivityStartsWithWorkAndEndsOnlyAfterEverythingIsConfirmedQuietForAWhile() async throws {
        let port = FakeActivity()
        var clock = t0
        var rows = [try row("a", level: "active", icon: "working", since: 0)]
        var online = true
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, reloadWidgets: {}), now: { clock }, sleep: { _ in })
        hub.read = { ([.init(hostId: "studio", rows: rows, online: online)], [:]) }
        hub.rebuild()
        #expect(port.started.count == 1)
        // It finishes: the activity stays, showing the result, through the quiet grace.
        rows = [try row("a", level: "done-unread", icon: "done")]
        clock = t0.addingTimeInterval(10)
        hub.rebuild()
        await hub.settle()
        #expect(port.running && port.ended.isEmpty)
        #expect(port.updated.last?.rows.first?.icon == "done")
        // The machine drops before the grace passes: unknown counts as busy, so nothing ends.
        online = false
        clock = t0.addingTimeInterval(10 + AgentsActivityPlan.quietGrace)
        hub.rebuild()
        await hub.settle()
        #expect(port.running && port.ended.isEmpty)
        #expect(port.updated.last?.current == false)
        // Back, still quiet: the grace starts again and only then the activity ends.
        online = true
        clock = clock.addingTimeInterval(1)
        hub.rebuild()
        clock = clock.addingTimeInterval(AgentsActivityPlan.quietGrace)
        hub.rebuild()
        await hub.settle()
        #expect(port.ended.count == 1)
        #expect(port.ended.first?.headline == "Nothing needs you")
    }

    @Test func workThatStartsWhileTheAppIsAwayWaitsForItToOpenAndTurningItOffEndsIt() async throws {
        let port = FakeActivity()
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, reloadWidgets: {}), now: { self.t0 }, sleep: { _ in })
        let working = try row("a", level: "active", icon: "working", since: 0)
        hub.read = { ([.init(hostId: "studio", rows: [working], online: true)], [:]) }
        hub.foreground = false
        hub.rebuild()
        #expect(port.started.isEmpty)
        hub.foreground = true
        hub.rebuild()
        #expect(port.started.count == 1)
        hub.allowed = false
        hub.rebuild()
        await hub.settle()
        #expect(port.ended.count == 1 && !port.running)
    }

    @Test func theWidgetsSnapshotIsRewrittenOnlyWhenWhatItShowsChanges() throws {
        var writes: [LockSummary] = []
        var reloads = 0
        var clock = t0
        let hub = LockScreenHub(edges: .init(activity: FakeActivity(), writeSnapshot: { writes.append($0) }, reloadWidgets: { reloads += 1 }),
                                now: { clock }, sleep: { _ in })
        let working = try row("a", level: "active", icon: "working", since: 0)
        hub.read = { ([.init(hostId: "studio", rows: [working], online: true)], [:]) }
        hub.rebuild()
        clock = clock.addingTimeInterval(5)
        hub.rebuild()
        #expect(writes.count == 1 && reloads == 1)
        // Unchanged for a while: written again so its "as of" time moves, without a reload.
        clock = clock.addingTimeInterval(LockScreenHub.snapshotRenewal)
        hub.rebuild()
        #expect(writes.count == 2 && reloads == 1)
    }

    @Test func aSnapshotWrittenByTheAppIsWhatTheWidgetsRead() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "lock-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let summary = LockScreenBuilder.summary([.init(hostId: "studio", rows: (0..<9).map { try! row("t\($0)", level: "needs-you", icon: "approve") }, online: true)],
                                                requests: [:], now: t0)
        LockSnapshotStore.write(summary, to: url)
        let read = try #require(LockSnapshotStore.read(from: url))
        #expect(read.needsYou == 9)
        #expect(read.rows.count == LockSnapshotStore.maxRows)
        #expect(read.updatedAt == t0)
    }

    // MARK: Support

    private func row(_ id: String, level: String, icon: String, since: Double? = nil, confirmed: Bool = true) throws -> ThreadRow {
        let look = #"{"level":"\#(level)","tone":"idle","muted":false,"settled":false,"subagents":0,"icon":"\#(icon)","iconTone":"working","mode":"\#(since == nil ? "icon" : "elapsed")","meaning":"Working"\#(since.map { #","since":\#($0)"# } ?? "")}"#
        let json = #"{"id":"\#(id)","title":"Thread \#(id)","state":"working","project":"ace","branch":"main","machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,"canSteer":true,"status":{"label":"Working","token":"working"},"confirmed":\#(confirmed),"generation":0,"look":\#(look)}"#
        return try JSONDecoder().decode(ThreadRow.self, from: Data(json.utf8))
    }
}

@MainActor private final class FakeActivity: AgentsActivityPort {
    var systemAllowed = true
    var running = false
    var started: [LockSummary] = []
    var updated: [LockSummary] = []
    var ended: [LockSummary] = []
    func start(_ summary: LockSummary, staleDate: Date) throws { started.append(summary); running = true }
    func update(_ summary: LockSummary, staleDate: Date) async { updated.append(summary) }
    func end(_ summary: LockSummary, dismissAt: Date) async { ended.append(summary); running = false }
}
