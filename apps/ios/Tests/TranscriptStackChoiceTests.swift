import Testing
@testable import Ace

/// Which stack holds the feed's rows: a plain stack while the window is short (a lazy one's height
/// estimates for a few uneven rows could swap by a point forever, #2051), the lazy one past a limit.
/// A switch rebuilds every row, so it happens rarely and only while the feed is still.
@Suite struct TranscriptStackChoiceTests {
    private let limit = 100

    @Test func aShortWindowOpensEagerAndALongOneLazy() {
        var short = TranscriptStackChoice(limit: limit)
        let r1 = short.opened(rows: 24)
        #expect(r1 == .eager)
        let r2 = short.opened(rows: 500)
        #expect(r2 == .eager, "the first choice holds")
        var long = TranscriptStackChoice(limit: limit)
        let r3 = long.opened(rows: 101)
        #expect(r3 == .lazy)
        var full = TranscriptStackChoice(limit: limit)
        let r4 = full.opened(rows: limit)
        #expect(r4 == .eager)
    }

    @Test func aWindowGrowingPastTheLimitTurnsLazyOnlyOnceTheFeedIsStill() {
        var choice = TranscriptStackChoice(limit: limit)
        _ = choice.opened(rows: 80)
        let r5 = choice.update(rows: 130, moving: true)
        #expect(r5 == nil)
        #expect(choice.stack == .eager)
        let r6 = choice.update(rows: 130, moving: false)
        #expect(r6 == .lazy)
        let r7 = choice.update(rows: 130, moving: false)
        #expect(r7 == nil)
    }

    @Test func aLazyWindowThatShrinksStaysLazyUntilItIsReplaced() {
        var choice = TranscriptStackChoice(limit: limit)
        _ = choice.opened(rows: 300)
        let r8 = choice.update(rows: 20, moving: false)
        #expect(r8 == nil)
        let r9 = choice.update(rows: 20, moving: false, replaced: true)
        #expect(r9 == .eager)
    }

    @Test func aReplacementWhileScrollingWaitsForTheFeedToBeStill() {
        var choice = TranscriptStackChoice(limit: limit)
        _ = choice.opened(rows: 300)
        let r10 = choice.update(rows: 20, moving: true, replaced: true)
        #expect(r10 == nil)
        #expect(choice.stack == .lazy)
        let r11 = choice.update(rows: 20, moving: false)
        #expect(r11 == .eager)
    }

    @Test func aLazyWindowReplacedBetweenTheMarksStaysLazy() {
        var choice = TranscriptStackChoice(limit: limit)
        _ = choice.opened(rows: 300)
        // Above three quarters of the limit: not short enough to rebuild for.
        let r12 = choice.update(rows: 90, moving: false, replaced: true)
        #expect(r12 == nil)
        let r13 = choice.update(rows: 76, moving: false, replaced: true)
        #expect(r13 == nil)
        let r14 = choice.update(rows: 75, moving: false, replaced: true)
        #expect(r14 == .eager)
    }

    @Test func rowsHoveringAroundTheLimitSwitchAtMostOnce() {
        var choice = TranscriptStackChoice(limit: limit)
        _ = choice.opened(rows: 99)
        var switches = 0
        for step in 0..<40 {
            let rows = step.isMultiple(of: 2) ? 101 : 99
            let switched = choice.update(rows: rows, moving: false, replaced: step.isMultiple(of: 3))
            if switched != nil { switches += 1 }
        }
        #expect(switches == 1)
        #expect(choice.stack == .lazy)
    }

    @Test func nothingSwitchesBeforeTheFirstLayout() {
        var choice = TranscriptStackChoice(limit: limit)
        let r15 = choice.update(rows: 500, moving: false, replaced: true)
        #expect(r15 == nil)
        let r16 = choice.opened(rows: 500)
        #expect(r16 == .lazy)
    }
}
