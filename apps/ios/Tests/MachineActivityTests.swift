import Foundation
import Testing
@testable import Ace

/// One Live Activity per machine (ADR 0223): its content decodes what the push gateway sends,
/// the widget shows the snapshot's rows only beside the counts they go with, a local write never
/// goes below the `seq` an activity shows, and each machine keeps its own slot and token.
@Suite @MainActor struct MachineActivityTests {
    typealias State = MachineActivityAttributes.ContentState
    private let t0 = Date(timeIntervalSince1970: 1_795_500_000)

    @Test func theContentDecodesExactlyWhatTheGatewaySends() throws {
        let url = try #require(Bundle(for: FixtureToken.self).url(forResource: "live-activity-content-state", withExtension: "json"))
        let states = try JSONDecoder().decode([String: State].self, from: Data(contentsOf: url))
        let start = try #require(states["start"])
        #expect(start.seq == 41 && start.at == 1_795_500_000 && !start.settled)
        #expect(start.working == 1 && start.needsYou == 0)
        #expect(start.rows == nil)
        let update = try #require(states["update"])
        #expect(update.seq == 42 && update.needsYou == 1 && update.working == 999)
        #expect(update.waiting == 2 && update.limited == 3 && update.background == 4 && update.done == 5)
        // Words come from the widget, never the push.
        #expect(MachineActivityLook(state: update, snapshot: nil, stale: false).headline == "1 needs you · 999 working · 2 waiting")
    }

    @Test func anUnknownPhaseReadsAsBusyNeverAsSettled() throws {
        let json = #"{"seq":1,"at":1,"phase":"later","needsYou":0,"working":0,"failed":0,"waiting":0,"limited":0,"background":0,"done":3}"#
        let state = try JSONDecoder().decode(State.self, from: Data(json.utf8))
        #expect(!state.settled)
        #expect(MachineActivityLook(state: state, snapshot: nil, stale: false).headline != "3 done")
    }

    @Test func theSnapshotsNameAndRowsShowOnlyBesideTheCountsTheyGoWith() {
        let pushed = state(seq: 42, needsYou: 1)
        let entry = MachineLockEntry(slot: 0, name: "MacBook Pro", seq: 42, rows: [row("a")], request: request)
        let matched = MachineActivityLook(state: pushed, snapshot: entry, stale: false)
        #expect(matched.rows.map(\.id) == ["a"])
        #expect(matched.note == "MacBook Pro")
        #expect(matched.request == request)
        // A newer push than the app's last snapshot: counts alone, and a nudge to open ace.
        let newer = MachineActivityLook(state: state(seq: 43, needsYou: 1), snapshot: entry, stale: false)
        #expect(newer.rows.isEmpty && newer.request == nil)
        #expect(newer.headline == "1 needs you")
        #expect(newer.note == "Open ace for details")
    }

    @Test func staleContentReadsAsOfItsTimeAndOffersNoAnswer() {
        let entry = MachineLockEntry(slot: 0, name: "MacBook Pro", seq: 42, rows: [row("a")], request: request)
        let look = MachineActivityLook(state: state(seq: 42, needsYou: 1), snapshot: entry, stale: true)
        #expect(look.note == "as of \(t0.formatted(date: .omitted, time: .shortened))")
        #expect(look.request == nil)
        #expect(look.summary.asOf(stale: look.stale))
    }

    @Test func aSettledEndSaysWhatFinished() {
        var ended = state(seq: 50)
        ended.phase = "settled"
        ended.done = 3
        ended.failed = 1
        #expect(MachineActivityLook(state: ended, snapshot: nil, stale: false).headline == "3 done · 1 failed")
    }

    @Test func aLocalWriteBelowTheSeqTheActivityShowsIsRefused() {
        #expect(!MachineActivityPlan.accepts(state(seq: 41), over: state(seq: 42)))
        #expect(MachineActivityPlan.accepts(state(seq: 42), over: state(seq: 42)))
        #expect(MachineActivityPlan.accepts(state(seq: 0), over: nil))
        // The app writes at whichever is later: what shows, or what it last wrote.
        #expect(MachineActivityPlan.localSeq(shown: state(seq: 42), written: 7) == 42)
        #expect(MachineActivityPlan.localSeq(shown: state(seq: 3), written: 7) == 7)
    }

    @Test func anInboxThatLagsBehindAPushedApprovalNeverWritesOverItsCounts() async throws {
        let port = FakeMachineActivity()
        // The daemon pushed "1 needs you" at 42; this phone's socket still lists the thread working.
        let pushed = state(seq: 42, needsYou: 1)
        port.showing[2] = pushed
        var written: [MachineLockEntry] = []
        var daemonSeq: Int?
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, writeMachines: { written = $0 }, reloadWidgets: {}),
                                now: { self.t0.addingTimeInterval(5) }, sleep: { _ in })
        hub.read = { ([.init(hostId: "studio", rows: [try! LockRows.row("a", level: "active", icon: "working", since: 0)], online: true,
                             slot: 2, name: "Studio", daemonSeq: daemonSeq)], [:]) }
        hub.rebuild()
        await hub.settle()
        #expect(port.updated.isEmpty && port.ended.isEmpty)
        #expect(port.showing[2] == pushed)
        // No snapshot entry goes with 42, so the widget shows the pushed counts alone.
        #expect(written.isEmpty)
        // The socket confirms its rows go with 42: they join, and the daemon's counts and times stay.
        daemonSeq = 42
        hub.rebuild()
        await hub.settle()
        let joined = try #require(port.updated.last?.state)
        #expect(joined.needsYou == 1 && joined.working == 0 && joined.at == pushed.at && joined.seq == 42)
        #expect(joined.rows?.map(\.id) == ["a"] && joined.localCounts == nil)
        #expect(written.map(\.seq) == [42])
        // Rows added locally don't make the counts the app's own: the next inbox change keeps them.
        hub.rebuild()
        await hub.settle()
        #expect(port.showing[2]?.needsYou == 1 && port.ended.isEmpty)
    }

    @Test func workStillSyncingNeverReadsAsQuietEvenBesideAMatchingSnapshot() throws {
        let port = FakeMachineActivity()
        var written: [MachineLockEntry] = []
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, writeMachines: { written = $0 }, reloadWidgets: {}),
                                now: { self.t0 }, sleep: { _ in })
        let syncing = try LockRows.row("a", level: "quiet", icon: "none", confirmed: false)
        hub.read = { ([.init(hostId: "studio", rows: [syncing], online: true, slot: 0)], [:]) }
        hub.rebuild()
        let shown = try #require(port.started.last?.state)
        let entry = try #require(written.first)
        #expect(!shown.settled && entry.seq == shown.seq && !entry.confirmed)
        let look = MachineActivityLook(state: shown, snapshot: entry, stale: false)
        #expect(look.headline == MachineActivityLook.unknown)
        #expect(!look.summary.current)
        // Even a confirmed snapshot can't make busy content with nothing counted read as quiet.
        var confirmed = entry
        confirmed.confirmed = true
        #expect(MachineActivityLook(state: shown, snapshot: confirmed, stale: false).headline != "Nothing needs you")
    }

    @Test func twoBusyMachinesEachGetTheirOwnActivity() throws {
        let port = FakeMachineActivity()
        let hub = LockScreenHub(edges: .init(activity: port, writeSnapshot: { _ in }, reloadWidgets: {}), now: { self.t0 }, sleep: { _ in })
        hub.read = { ([
            .init(hostId: "studio", rows: [try! LockRows.row("a", level: "active", icon: "working", since: 0)], online: true, slot: 0),
            .init(hostId: "laptop", rows: [try! LockRows.row("b", level: "needs-you", icon: "approve")], online: true, slot: 1),
        ], [:]) }
        hub.rebuild()
        #expect(port.started.map(\.slot) == [0, 1])
        #expect(port.showing[0]?.working == 1 && port.showing[0]?.needsYou == 0)
        #expect(port.showing[1]?.needsYou == 1)
    }

    @Test func eachMachineKeepsItsSlotAndANewOneTakesTheLowestFree() {
        var slots = MachineSlots.assign("studio", kept: [:], attached: ["studio"])
        slots = MachineSlots.assign("laptop", kept: slots, attached: ["studio", "laptop"])
        #expect(slots == ["studio": 0, "laptop": 1])
        #expect(MachineSlots.assign("studio", kept: slots, attached: ["studio"]) == slots)
        // All sixteen taken: one held by a machine no longer attached is reused.
        let full = Dictionary(uniqueKeysWithValues: (0..<16).map { ("m\($0)", $0) })
        let attached = Set(full.keys).subtracting(["m5"]).union(["new"])
        #expect(MachineSlots.assign("new", kept: full, attached: attached)["new"] == 5)
        #expect(MachineSlots.assign("new", kept: full, attached: Set(full.keys))["new"] == nil)
    }

    @Test func anEndedActivityTakesOnlyItsOwnTokenAndTurningLiveActivitiesOffDropsTheSyncField() throws {
        var tokens = LiveActivityTokens()
        tokens.start = "ef"
        tokens.received("aa", slot: 0, activity: "old")
        tokens.received("bb", slot: 0, activity: "new")
        tokens.ended(activity: "old")
        #expect(tokens.activityToken(slot: 0) == "bb")
        let field = try #require(tokens.sync(on: true, slot: 0, environment: .sandbox, frequentUpdates: false))
        #expect(field["startToken"] as? String == "ef" && field["activityToken"] as? String == "bb")
        #expect(field["slot"] as? Int == 0 && field["environment"] as? String == "sandbox" && field["frequentUpdates"] as? Bool == false)
        tokens.ended(activity: "new")
        #expect(tokens.sync(on: true, slot: 0, environment: .sandbox, frequentUpdates: true)?["activityToken"] == nil)
        // Off in ace or in iOS Settings, or no slot: no `liveActivity` at all.
        #expect(tokens.sync(on: false, slot: 0, environment: .sandbox, frequentUpdates: true) == nil)
        #expect(tokens.sync(on: true, slot: nil, environment: .sandbox, frequentUpdates: true) == nil)
    }

    // MARK: Support

    private var request: LockRequest {
        LockRequest(hostId: "studio", threadId: "a", interactionId: "i", approve: "allow", deny: "deny",
                    sentence: "Claude Code wants to run a command", detail: "bun run test", code: true, title: "Fix")
    }
    private func state(seq: Int, needsYou: Int = 0) -> State {
        State(seq: seq, at: Int(t0.timeIntervalSince1970), phase: "busy", needsYou: needsYou, working: 0, failed: 0,
              waiting: 0, limited: 0, background: 0, done: 0)
    }
    private func row(_ id: String) -> LockRow {
        LockRow(id: id, hostId: "studio", title: "Thread \(id)", icon: "approve", tone: "needs-you", meaning: "Needs approval",
                link: "ace://thread/\(id)?machine=studio", needsYou: true)
    }
}

private final class FixtureToken {}

/// The ActivityKit edge as tests see it: what each slot shows, and every write to it.
@MainActor final class FakeMachineActivity: MachineActivityPort {
    typealias State = MachineActivityAttributes.ContentState
    var systemAllowed = true
    var frequentUpdates = true
    var tokens = LiveActivityTokens()
    var onChange: (@MainActor () -> Void)?
    var showing: [Int: State] = [:]
    var started: [(slot: Int, state: State)] = []
    var updated: [(slot: Int, state: State)] = []
    var ended: [(slot: Int, state: State?)] = []
    var running: Set<Int> { Set(showing.keys) }
    func shown(_ slot: Int) -> State? { showing[slot] }
    func start(_ slot: Int, _ state: State, staleDate: Date) throws { started.append((slot, state)); showing[slot] = state }
    func update(_ slot: Int, _ state: State, staleDate: Date) async { updated.append((slot, state)); showing[slot] = state }
    func end(_ slot: Int, _ state: State?, dismissAt: Date) async { ended.append((slot, state)); showing.removeValue(forKey: slot) }
}

/// Inbox rows as the bridge sends them, for the lock-screen suites.
enum LockRows {
    /// The bridge's state for each mark, as `rowStatusState` gives it.
    static let states = ["working": "working", "agents": "working", "waiting": "waiting", "limited": "limited",
                         "background": "background", "approve": "needs-you", "question": "needs-you",
                         "failed": "failed", "done": "finished", "none": "idle"]
    static func row(_ id: String, level: String, icon: String, since: Double? = nil, confirmed: Bool = true) throws -> ThreadRow {
        let state = states[icon] ?? "idle"
        let look = #"{"level":"\#(level)","state":"\#(state)","tone":"idle","muted":false,"settled":false,"subagents":0,"icon":"\#(icon)","iconTone":"working","mode":"\#(since == nil ? "icon" : "elapsed")","meaning":"Working"\#(since.map { #","since":\#($0)"# } ?? "")}"#
        let json = #"{"id":"\#(id)","title":"Thread \#(id)","state":"working","project":"ace","branch":"main","machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,"canSteer":true,"status":{"label":"Working","token":"working"},"confirmed":\#(confirmed),"generation":0,"look":\#(look)}"#
        return try JSONDecoder().decode(ThreadRow.self, from: Data(json.utf8))
    }
}
