import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptEndSettleTests {
    @Test func lazyLayoutFeedbackCannotRestartTheScrollBudget() async {
        var ticks = 0
        let settle = TranscriptEndSettle(pause: {
            ticks += 1
            if ticks > 100 { throw CancellationError() }
            await Task.yield()
        })
        var corrections = 0
        func request() {
            settle.run(gap: { 20 }, wait: { false }) {
                corrections += 1
                request()
            }
        }
        request()
        for _ in 0..<1000 where settle.isRunning { await Task.yield() }
        #expect(corrections == 30)
        #expect(!settle.isRunning)
        settle.cancel()
    }

    @Test func reachingTheEndStopsCorrectionAndANewContentChangeCanScrollAgain() async {
        let settle = TranscriptEndSettle(pause: { await Task.yield() })
        var gap: CGFloat = 10
        var corrections = 0
        func request() {
            settle.run(gap: { gap }, wait: { false }) { corrections += 1; gap = 0 }
        }
        request()
        for _ in 0..<1000 where settle.isRunning { await Task.yield() }
        #expect(corrections == 1)
        #expect(!settle.isRunning)
        gap = 10
        request()
        for _ in 0..<1000 where settle.isRunning { await Task.yield() }
        #expect(corrections == 2)
    }
}
