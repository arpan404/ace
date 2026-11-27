import Foundation
import Testing
@testable import Ace

/// The lock screen across machines: what the summary counts and shows, when a machine's Live
/// Activity starts and ends, and that nothing reads as quiet or done while a machine's state
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

    @Test func theActivityStartsWithWorkAndEndsOnlyAfterItsMachineIsConfirmedQuietForAWhile() async throws {
        let port = FakeMachineActivity()
        var clock = t0
        var rows = [try row("a", level: "active", icon: "working", since: 0)]
        var online = true
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, reloadWidgets: {}), now: { clock }, sleep: { _ in })
        hub.read = { ([.init(hostId: "studio", rows: rows, online: online, slot: 0)], [:]) }
        hub.rebuild()
        #expect(port.started.count == 1)
        // It finishes: the activity stays, showing the result, through the quiet grace.
        rows = [try row("a", level: "done-unread", icon: "done")]
        clock = t0.addingTimeInterval(10)
        hub.rebuild()
        await hub.settle()
        #expect(port.running == [0] && port.ended.isEmpty)
        #expect(port.updated.last?.state.rows?.first?.icon == "done")
        // The machine drops before the grace passes: nothing new is known, so the activity
        // keeps what it shows (its daemon may push newer) and nothing ends.
        let updates = port.updated.count
        online = false
        clock = t0.addingTimeInterval(10 + MachineActivityPlan.quietGrace)
        hub.rebuild()
        await hub.settle()
        #expect(port.running == [0] && port.ended.isEmpty)
        #expect(port.updated.count == updates)
        // Back, still quiet: the grace starts again and only then the activity ends.
        online = true
        clock = clock.addingTimeInterval(1)
        hub.rebuild()
        clock = clock.addingTimeInterval(MachineActivityPlan.quietGrace)
        hub.rebuild()
        await hub.settle()
        #expect(port.ended.count == 1)
        #expect(port.ended.first?.state?.settled == true)
    }

    @Test func workThatStartsWhileTheAppIsAwayWaitsForItToOpenAndTurningItOffEndsIt() async throws {
        let port = FakeMachineActivity()
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, reloadWidgets: {}), now: { self.t0 }, sleep: { _ in })
        let working = try row("a", level: "active", icon: "working", since: 0)
        hub.read = { ([.init(hostId: "studio", rows: [working], online: true, slot: 0)], [:]) }
        hub.foreground = false
        hub.rebuild()
        #expect(port.started.isEmpty)
        hub.foreground = true
        hub.rebuild()
        #expect(port.started.count == 1)
        hub.allowed = false
        hub.rebuild()
        await hub.settle()
        #expect(port.ended.count == 1 && port.running.isEmpty)
    }

    @Test func aColdWakeKeepsTheLastWidgetCountsUntilAMachineConfirms() throws {
        let working = try row("a", level: "active", icon: "working", since: 0)
        let saved = LockScreenBuilder.summary([.init(hostId: "studio", rows: [working], online: true)], requests: [:], now: t0)
        var writes: [LockSummary] = []
        let hub = LockScreenHub(edges: .init(activity: FakeMachineActivity(), writeSnapshot: { writes.append($0) },
                                             reloadWidgets: {}, readSnapshot: { saved }),
                                now: { self.t0.addingTimeInterval(60) }, sleep: { _ in })
        hub.foreground = false
        hub.rebuild()
        #expect(writes.last?.rows.first?.id == "a")
        #expect(writes.last?.current == false)
        #expect(writes.last?.updatedAt == t0)
        hub.read = { ([.init(hostId: "studio", rows: [], online: true)], [:]) }
        hub.rebuild()
        #expect(writes.last?.current == true)
        #expect(writes.last?.rows.isEmpty == true)
    }

    @Test func theWidgetsSnapshotIsRewrittenOnlyWhenWhatItShowsChanges() throws {
        var writes: [LockSummary] = []
        var reloads = 0
        var clock = t0
        let hub = LockScreenHub(edges: .init(activity: FakeMachineActivity(), writeSnapshot: { writes.append($0) }, reloadWidgets: { reloads += 1 }),
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

    @Test func waitsAndUsageLimitsAreNeverCountedAsWorkingAndShowNoRunningTime() throws {
        // The report's morning: eight busy rows, three of them working.
        let summary = LockScreenBuilder.summary([.init(hostId: "studio", rows: [
            try row("w1", level: "active", icon: "working", since: 300),
            try row("w2", level: "active", icon: "working", since: 200),
            try row("q1", level: "active", icon: "waiting", since: 100),
            try row("q2", level: "active", icon: "waiting", since: 110),
            try row("q3", level: "active", icon: "waiting", since: 120),
            try row("l1", level: "active", icon: "limited"),
            try row("l2", level: "active", icon: "limited"),
            try row("b1", level: "active", icon: "background", since: 50),
        ], online: true)], requests: [:], now: t0)
        #expect(summary.working == 2 && summary.waiting == 3 && summary.limited == 2 && summary.background == 1)
        #expect(summary.headline == "2 working · 3 waiting · 2 limited")
        // Working first, then the waits; only live work counts its running time.
        #expect(summary.rows.prefix(3).map(\.id) == ["w2", "w1", "q1"])
        #expect(summary.rows.first { $0.id == "q1" }?.since == nil)
        let background = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("b1", level: "active", icon: "background", since: 50)], online: true)],
                                                   requests: [:], now: t0)
        #expect(background.rows.first?.since != nil)
        #expect(background.headline == "1 in background")
    }

    @Test func aFinishedRootWhoseSubagentsStillWorkCountsAsWorking() throws {
        let summary = LockScreenBuilder.summary([.init(hostId: "studio", rows: [try row("a", level: "active", icon: "agents", since: 10)], online: true)],
                                                requests: [:], now: t0)
        #expect(summary.working == 1)
        #expect(summary.headline == "1 working")
    }

    @Test func needingThePersonLeadsTheHeadlineAndTheRows() throws {
        let summary = LockScreenBuilder.summary([.init(hostId: "studio", rows: [
            try row("w", level: "active", icon: "working", since: 1),
            try row("q", level: "active", icon: "waiting", since: 2),
            try row("n", level: "needs-you", icon: "approve"),
        ], online: true)], requests: [:], now: t0)
        #expect(summary.headline == "1 needs you · 1 working · 1 waiting")
        #expect(summary.rows.first?.id == "n")
    }

    @Test func aPairedMachineThatIsOffIsANoteBesideFreshCountsNotAnAsOf() throws {
        let summary = LockScreenBuilder.summary([
            .init(hostId: "studio", rows: [try row("a", level: "active", icon: "working", since: 1)], online: true),
            .init(hostId: "vm", rows: [], online: false),
        ], requests: [:], now: t0)
        #expect(summary.live && !summary.current)
        #expect(summary.headline == "1 working")
        #expect(summary.note(stale: false, fresh: "ace") == "1 machine offline")
        #expect(!summary.asOf(stale: false))
        // Nothing else to count: the offline machine is the sentence, never "Nothing needs you".
        let quiet = LockScreenBuilder.summary([.init(hostId: "studio", rows: [], online: true), .init(hostId: "vm", rows: [], online: false)],
                                              requests: [:], now: t0)
        #expect(quiet.headline == "1 machine offline")
        #expect(!quiet.busy)
        // Past its stale date the same content says "as of" its time.
        #expect(summary.asOf(stale: true))
    }

    @Test func whenNoMachineAnswersTheWidgetsKeepTheLastConfirmedCountsAsOfTheirTime() throws {
        var clock = t0
        var online = true
        var writes: [LockSummary] = []
        let hub = LockScreenHub(edges: .init(activity: FakeMachineActivity(), writeSnapshot: { writes.append($0) }, reloadWidgets: {}),
                                now: { clock }, sleep: { _ in })
        let working = try row("a", level: "active", icon: "working", since: 0)
        hub.read = { ([.init(hostId: "studio", rows: online ? [working] : [], online: online, slot: 0)], [:]) }
        hub.rebuild()
        online = false
        clock = t0.addingTimeInterval(30)
        hub.rebuild()
        let shown = try #require(writes.last)
        #expect(shown.headline == "1 working")
        #expect(!shown.live && shown.asOf(stale: false))
        #expect(shown.updatedAt == t0)
    }

    // MARK: Support

    private func row(_ id: String, level: String, icon: String, since: Double? = nil, confirmed: Bool = true) throws -> ThreadRow {
        try LockRows.row(id, level: level, icon: icon, since: since, confirmed: confirmed)
    }
}
