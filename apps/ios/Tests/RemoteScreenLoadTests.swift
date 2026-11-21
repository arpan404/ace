import Foundation
import Testing
@testable import Ace

/// The Computer use page reads the machine's computer use and ends every read in something to
/// show: the machine's state as soon as it answers, or what went wrong with Try again. Never a
/// placeholder that waits for nothing.
@MainActor @Suite struct RemoteScreenLoadTests {
    private static let status: ServiceValue = .object([
        "ok": .bool(true),
        "data": .object([
            "enabled": .bool(true), "sessions": .number(0),
            "permissions": .object(["screenRecording": .bool(true), "accessibility": .bool(false)]),
        ]),
    ])
    private static let noSessions: ServiceValue = .object(["ok": .bool(true), "data": .array([])])
    private static let noShaped: ServiceValue = .object(["ok": .bool(true), "data": .object(["sessions": .array([])])])

    /// The request's name as the bridge routes it: "status", "sessions", or "screen.sessions".
    private static func name(_ payload: [String: Any]) -> String {
        (payload["operation"] as? [String: Any])?["op"] as? String ?? payload["type"] as? String ?? ""
    }

    private static func answer(_ payload: [String: Any]) -> ServiceValue {
        switch name(payload) {
        case "status": status
        case "sessions": noSessions
        default: noShaped
        }
    }

    @Test func thePageShowsTheMachinesStateAsSoonAsStatusAnswersWhileTheAppsAreStillRead() async throws {
        let screen = RemoteScreen()
        let gate = Gate()
        let load = Task {
            await screen.load { payload, _ in
                switch Self.name(payload) {
                case "status": return Self.status
                case "sessions": await gate.wait(); return Self.noSessions
                default: return Self.noShaped
                }
            }
        }
        while screen.status == nil { await Task.yield() }
        #expect(screen.page == .shown)
        #expect(screen.status?.permissions.accessibility == false)
        gate.open()
        await load.value
        #expect(screen.page == .shown)
        #expect(screen.sessions.isEmpty)
    }

    @Test func aRefusedReadShowsTheMachinesWordsInsteadOfTheSkeleton() async {
        let screen = RemoteScreen()
        await screen.load { _, _ in
            .object(["ok": .bool(false), "error": .object(["message": .string("Screen access is disabled"), "code": .string("screen_disabled")])])
        }
        #expect(screen.page == .failed("Screen access is disabled"))
    }

    @Test func aReadThatNeverGotAnAnswerShowsWhyInsteadOfTheSkeleton() async {
        let screen = RemoteScreen()
        await screen.load { _, _ in throw ServiceFailure(message: "The request timed out.", transport: true) }
        #expect(screen.page == .failed("The request timed out."))
    }

    @Test func aReadCancelledBeforeItAnsweredOffersTryAgainRatherThanWaitingForever() async {
        let screen = RemoteScreen()
        let gate = Gate()
        let load = Task { await screen.load { _, _ in await gate.wait(); throw CancellationError() } }
        while !gate.held { await Task.yield() }
        load.cancel()
        gate.open()
        await load.value
        guard case .failed = screen.page else { Issue.record("Still \(screen.page) after the read was cancelled"); return }
    }

    @Test func anOlderReadEndingLateKeepsTheNewerReadsWait() async {
        let screen = RemoteScreen()
        let first = Gate(), second = Gate()
        let older = Task { await screen.load { _, _ in await first.wait(); throw ServiceFailure(message: "Request cancelled") } }
        while !first.held { await Task.yield() }
        let newer = Task { await screen.load { payload, _ in await second.wait(); return Self.answer(payload) } }
        while !second.held { await Task.yield() }
        first.open()
        await older.value
        // The older read's failure is said, but the newer read is still under way.
        #expect(screen.reading)
        second.open()
        await newer.value
        #expect(screen.page == .shown)
    }

    @Test func aMachineThatWentAwayStopsTheWaitAndSaysSo() {
        let screen = RemoteScreen()
        #expect(screen.page == .reading)
        screen.disconnected()
        guard case .failed = screen.page else { Issue.record("Still \(screen.page) while disconnected"); return }
    }
}
