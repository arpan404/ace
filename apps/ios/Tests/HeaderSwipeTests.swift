import Testing
@testable import Ace

/// A changed file's header takes a sideways swipe to mark it viewed: only a clearly sideways drag
/// is the header's (anything steeper scrolls the list), the row follows the finger as far as its
/// reach, and letting go near the end of the reach marks it.
@Suite struct HeaderSwipeTests {
    @Test func onlyAClearlySidewaysDragIsTheHeaders() {
        #expect(HeaderSwipe.begins(dx: -300, dy: 40))
        #expect(HeaderSwipe.begins(dx: 250, dy: -20))
        #expect(!HeaderSwipe.begins(dx: 40, dy: -300), "scrolling the list")
        #expect(!HeaderSwipe.begins(dx: 100, dy: 60), "a diagonal stays the list's")
        #expect(!HeaderSwipe.begins(dx: 0, dy: 0))
    }

    @Test func theRowFollowsTheFingerAsFarAsItsReach() {
        #expect(HeaderSwipe.offset(-30, reach: 88) == -30)
        #expect(HeaderSwipe.offset(-400, reach: 88) == -88)
        #expect(HeaderSwipe.offset(400, reach: 88) == 88)
    }

    @Test func lettingGoNearTheEndOfTheReachMarksEitherWay() {
        #expect(HeaderSwipe.marks(-88, reach: 88))
        #expect(HeaderSwipe.marks(72, reach: 88))
        #expect(!HeaderSwipe.marks(-60, reach: 88), "a short drag springs back")
    }
}
