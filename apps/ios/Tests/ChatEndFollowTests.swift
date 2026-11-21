import Testing
@testable import Ace

/// When a messenger-style chat (Spade's) keeps its end on screen: from opening until the person
/// scrolls back, and again once they come to rest at the end or send.
@Suite struct ChatEndFollowTests {
    @Test func aChatOpensFollowingItsEnd() {
        #expect(ChatEndFollow(slack: 24).following)
    }

    @Test func draggingBackToOlderMessagesStopsFollowingAtOnce() {
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.scrolled(towardOlder: true)
        #expect(!follow.following, "a streamed line arriving mid-drag must not pull the reader back")
    }

    @Test func comingToRestAwayFromTheEndKeepsTheReadersPlace() {
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.rested(fromEnd: 400, viewport: 800)
        #expect(!follow.following)
    }

    @Test func comingToRestAtTheEndFollowsAgain() {
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.scrolled(towardOlder: true)
        follow.rested(fromEnd: 300, viewport: 800)
        follow.touched()
        follow.rested(fromEnd: 10, viewport: 800)
        #expect(follow.following)
    }

    @Test func growthBelowTheReaderNeverChangesWhetherItFollows() {
        // A streaming answer moves the end away with no finger on the screen.
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.rested(fromEnd: 400, viewport: 800)
        follow.rested(fromEnd: 20, viewport: 800)
        #expect(!follow.following, "only the person's own scroll coming to rest at the end follows again")
    }

    @Test func aScrollThePersonDidntDragFarFromTheEndStopsFollowing() {
        // The status bar's tap to the top, or VoiceOver.
        var follow = ChatEndFollow(slack: 24)
        follow.rested(fromEnd: 3_000, viewport: 800)
        #expect(!follow.following)
    }

    @Test func sendingFollowsTheEndFromWhereverThePersonWas() {
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.rested(fromEnd: 2_000, viewport: 800)
        follow.sent()
        #expect(follow.following)
    }

    @Test func jumpingToACardStopsFollowing() {
        var follow = ChatEndFollow(slack: 24)
        follow.jumped()
        #expect(!follow.following)
    }

    @Test func theEndsDistanceIsMeasuredFromTheBottomEdgeOfWhatShows() {
        // 2,000 of content, 700 tall inside a 100 header, scrolled 1,000 down from its top.
        #expect(ScrollEnd.fromEnd(contentHeight: 2_000, offsetY: 1_000, containerHeight: 700, topInset: 100) == 200)
        // Scrolled to its end.
        #expect(ScrollEnd.fromEnd(contentHeight: 2_000, offsetY: 1_200, containerHeight: 700, topInset: 100) == 0)
    }
}
