import Foundation
import Testing
@testable import Ace

/// The Computer use page reads the machine's computer use and ends every read in something to
/// show: the machine's state as soon as it answers, or what went wrong with Try again. Never a
/// placeholder that waits for nothing.
@MainActor @Suite struct RemoteScreenLoadTests {
    private static let status = statusReply(enabled: true)
    private static func statusReply(enabled: Bool) -> ServiceValue {
        .object([
            "ok": .bool(true),
            "data": .object([
                "enabled": .bool(enabled), "sessions": .number(0),
                "permissions": .object(["screenRecording": .bool(true), "accessibility": .bool(false)]),
            ]),
        ])
    }
    private static let noTargets: ServiceValue = .object(["ok": .bool(true), "data": .object(["windows": .array([])])])
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
        try await until("the status answer") { screen.status != nil }
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

    @Test func aReadCancelledBeforeItAnsweredOffersTryAgainRatherThanWaitingForever() async throws {
        let screen = RemoteScreen()
        let gate = Gate()
        let load = Task { await screen.load { _, _ in await gate.wait(); throw CancellationError() } }
        try await until("the read waiting") { gate.held }
        load.cancel()
        gate.open()
        await load.value
        guard case .failed = screen.page else { Issue.record("Still \(screen.page) after the read was cancelled"); return }
    }

    @Test func anOlderReadFailingLateLeavesTheNewerReadWaitingWithoutItsError() async throws {
        let screen = RemoteScreen()
        let first = Gate(), second = Gate()
        let older = Task { await screen.load { _, _ in await first.wait(); throw ServiceFailure(message: "The request timed out.") } }
        try await until("the older read waiting") { first.held }
        let newer = Task { await screen.load { payload, _ in await second.wait(); return Self.answer(payload) } }
        try await until("the newer read waiting") { second.held }
        first.open()
        await older.value
        #expect(screen.page == .reading)
        #expect(screen.readProblem == nil)
        second.open()
        await newer.value
        #expect(screen.page == .shown)
    }

    @Test func anOlderReadAnsweringLateNeverReplacesWhatTheNewerReadFound() async throws {
        let screen = RemoteScreen()
        let first = Gate()
        let older = Task {
            await screen.load { payload, _ in
                await first.wait()
                return Self.name(payload) == "status" ? Self.statusReply(enabled: false) : Self.answer(payload)
            }
        }
        try await until("the older read waiting") { first.held }
        await screen.load { payload, _ in Self.answer(payload) }
        #expect(screen.status?.enabled == true)
        first.open()
        await older.value
        #expect(screen.status?.enabled == true)
        #expect(screen.page == .shown)
    }

    @Test func theSharePickersLookupSucceedingKeepsThePagesFailedReadAndItsTryAgain() async {
        let screen = RemoteScreen()
        await screen.load { payload, _ in
            if Self.name(payload) == "sessions" { throw ServiceFailure(message: "The request timed out.", transport: true) }
            return Self.answer(payload)
        }
        #expect(screen.readProblem == "The request timed out.")
        await screen.targets { _, _ in Self.noTargets }
        #expect(screen.readProblem == "The request timed out.")
        #expect(screen.page == .shown)
    }

    @Test func aMachineThatWentAwayStopsTheWaitAndSaysSo() {
        let screen = RemoteScreen()
        #expect(screen.page == .reading)
        screen.disconnected()
        guard case .failed = screen.page else { Issue.record("Still \(screen.page) while disconnected"); return }
    }
}

/// Yields until `ready` holds; fails the test instead of hanging when it never does.
@MainActor private func until(_ what: String, _ ready: () -> Bool) async throws {
    for _ in 0..<10_000 {
        if ready() { return }
        await Task.yield()
    }
    Issue.record("Never saw \(what)")
    throw CancellationError()
}
