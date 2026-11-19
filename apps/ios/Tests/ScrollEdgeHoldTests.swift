import CoreGraphics
import Testing
@testable import Ace

/// The pinned bar's scroll edge under the large title.
struct ScrollEdgeHoldTests {
    private func scrolling() -> ScrollEdgeHold {
        var hold = ScrollEdgeHold()
        hold.phase(scrolling: true, offset: 0)
        return hold
    }

    @Test func theEdgeStaysHiddenWhileTheLargeTitleCollapses() {
        var hold = scrolling()
        for offset in stride(from: CGFloat(-4), through: 40, by: 2) { hold.moved(to: offset) }
        #expect(!hold.shown)
    }

    @Test func aWobbleAroundTheHandOverNeverFlipsTheEdge() {
        var hold = scrolling()
        hold.moved(to: 60)
        var seen: Set<Bool> = []
        for offset: CGFloat in [50, 54, 30, 56, 20, 53, 12, 58] {
            hold.moved(to: offset)
            seen.insert(hold.shown)
        }
        #expect(seen == [true])
    }

    @Test func theEdgeHidesAgainBackAtTheTop() {
        var hold = scrolling()
        hold.moved(to: 120)
        hold.moved(to: 3)
        #expect(!hold.shown)
        hold.moved(to: 30)
        #expect(!hold.shown)
    }

    @Test func layoutMovingTheListWhileNobodyScrollsNeverFlipsTheEdge() {
        var hold = ScrollEdgeHold()
        var seen: Set<Bool> = []
        for offset: CGFloat in [0, 120, 2, 140, 0, 96, 4] {
            hold.moved(to: offset)
            seen.insert(hold.shown)
        }
        #expect(seen == [false])
    }

    @Test func aScrollComingToRestPastTheTitleShowsTheEdgeAndLayoutLeavesItThere() {
        var hold = scrolling()
        hold.phase(scrolling: false, offset: 140)
        #expect(hold.shown)
        hold.moved(to: 0)
        #expect(hold.shown)
    }

    @Test func anotherListStartsWithTheEdgeHiddenAndLayoutLeavesItSo() {
        var hold = scrolling()
        hold.phase(scrolling: false, offset: 140)
        hold.reset()
        #expect(!hold.shown)
        hold.moved(to: 140)
        #expect(!hold.shown)
    }
}
