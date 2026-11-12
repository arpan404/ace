import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptEndSettleTests {
    @Test func aFeedLeftPastItsEndWhenRowsMeasureShorterIsPutBackOnlyWhenNobodyMovesIt() {
        // Opened at the end of 5,000pt of estimated rows; they measured 600pt shorter, so the
        // still offset now shows 600pt of nothing below the end.
        #expect(TranscriptEnd.stranded(oldHeight: 5_000, newHeight: 4_400, toEnd: -600, moving: false))
        // A drag or the feed's own animation is left alone.
        #expect(!TranscriptEnd.stranded(oldHeight: 5_000, newHeight: 4_400, toEnd: -600, moving: true))
        // Shrinking that leaves the end in reach, or growing, needs nothing.
        #expect(!TranscriptEnd.stranded(oldHeight: 5_000, newHeight: 4_000, toEnd: 100, moving: false))
        #expect(!TranscriptEnd.stranded(oldHeight: 4_400, newHeight: 5_000, toEnd: -10, moving: false))
    }

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
