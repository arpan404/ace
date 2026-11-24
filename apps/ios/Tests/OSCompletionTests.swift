import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct OSCompletionTests {
    @Test func theWorksResultIsReportedOnceAndALaterOneIsIgnored() {
        var gate = CompletionGate(startedAt: 1_000, budget: 25_000)
        #expect(gate.finish(true, at: 3_000) == true)
        #expect(gate.finish(false, at: 4_000) == nil)
        #expect(gate.expire() == nil)
    }
    @Test func expirationReportsFailureAtOnceAndFencesTheWorkThatFinishesLater() {
        var gate = CompletionGate(startedAt: 1_000, budget: 25_000)
        #expect(gate.expire() == false)
        #expect(gate.finish(true, at: 2_000) == nil)
        #expect(gate.expire() == nil)
    }
    @Test func workThatFinishesPastTheDeadlineCountsAsFailed() {
        var gate = CompletionGate(startedAt: 1_000, budget: 25_000)
        #expect(gate.remaining(at: 21_000) == 5_000)
        #expect(gate.finish(true, at: 26_001) == false)
        #expect(gate.remaining(at: 30_000) == 0)
    }
    @Test func theShellReportsFailureWhenItsDeadlinePassesWhileTheWorkStillWaits() async {
        var reports: [Bool] = []
        let (passed, deadline) = AsyncStream.makeStream(of: Void.self)
        let done = OSCompletion(budget: .seconds(25), now: { 1_000 },
                                sleep: { _ in for await _ in passed { return } }) { reports.append($0) }
        deadline.yield()
        // Bounded, so a timer that never reports fails the test instead of hanging the run.
        for _ in 0..<10_000 where reports.isEmpty { await Task.yield() }
        #expect(reports == [false])
        // The shared refresh it joined comes back long after iOS was told.
        done.finish(true)
        #expect(reports == [false])
    }
    @Test func theShellReportsExpirationOnceHoweverOftenIOSAsks() {
        var reports: [Bool] = []
        let done = OSCompletion(budget: .seconds(25), now: { 1_000 }, sleep: { _ in await Task.yield() }) { reports.append($0) }
        done.expire()
        done.expire()
        done.finish(true)
        #expect(reports == [false])
    }
}
