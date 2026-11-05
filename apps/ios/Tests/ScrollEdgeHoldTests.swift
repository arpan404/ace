import CoreGraphics
import Testing
@testable import Ace

/// The pinned bar's scroll edge under the large title.
struct ScrollEdgeHoldTests {
    @Test func theEdgeStaysHiddenWhileTheLargeTitleCollapses() {
        var hold = ScrollEdgeHold()
        for offset in stride(from: CGFloat(-4), through: 40, by: 2) { hold.update(offset) }
        #expect(!hold.shown)
    }

    @Test func aWobbleAroundTheHandOverNeverFlipsTheEdge() {
        var hold = ScrollEdgeHold()
        hold.update(60)
        var seen: Set<Bool> = []
        for offset: CGFloat in [50, 54, 30, 56, 20, 53, 12, 58] {
            hold.update(offset)
            seen.insert(hold.shown)
        }
        #expect(seen == [true])
    }

    @Test func theEdgeHidesAgainBackAtTheTop() {
        var hold = ScrollEdgeHold()
        hold.update(120)
        hold.update(3)
        #expect(!hold.shown)
        hold.update(30)
        #expect(!hold.shown)
    }
}
