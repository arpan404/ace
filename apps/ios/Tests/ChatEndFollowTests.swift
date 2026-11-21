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

    @Test func aScrollThePersonDidntDragFarFromTheEndStopsFollowing() {
        // The status bar's tap to the top, or VoiceOver.
        var follow = ChatEndFollow(slack: 24)
        follow.rested(fromEnd: 3_000, viewport: 800)
        #expect(!follow.following)
    }

    @Test func aScrollThePersonDidntDragBackToTheEndFollowsAgain() {
        // VoiceOver scrolled a screen away, then back to the end, with no drag either way.
        var follow = ChatEndFollow(slack: 24)
        follow.rested(fromEnd: 3_000, viewport: 800)
        follow.rested(fromEnd: 10, viewport: 800)
        #expect(follow.following)
    }

    @Test func aScrollThePersonDidntDragBackToTheEndFollowsAgainAfterADragBack() {
        var follow = ChatEndFollow(slack: 24)
        follow.touched()
        follow.scrolled(towardOlder: true)
        follow.rested(fromEnd: 3_000, viewport: 800)
        follow.rested(fromEnd: 10, viewport: 800)
        #expect(follow.following)
    }

    @Test func voiceOverScrollingToTheEndAfterACardForLaterFollowsAgain() {
        // The card's jump stopped following; VoiceOver then scrolls back to the newest message.
        var follow = ChatEndFollow(slack: 24)
        follow.jumped()
        follow.rested(fromEnd: 1_200, viewport: 800)
        #expect(!follow.following)
        follow.rested(fromEnd: 0, viewport: 800)
        #expect(follow.following)
        #expect(follow.mayRestack, "the lazy stack held back for the reader may switch now")
    }

    @Test func theRowsChangeStackOnlyWhileTheChatFollowsItsEnd() {
        // Moving the rows to another stack can shift the ones a reader looking back is on.
        var follow = ChatEndFollow(slack: 24)
        #expect(follow.mayRestack)
        follow.touched()
        follow.scrolled(towardOlder: true)
        follow.rested(fromEnd: 400, viewport: 800)
        #expect(!follow.mayRestack)
        follow.sent()
        #expect(follow.mayRestack)
    }

    @Test func aSlowDragBackCountsOnceItHasMovedAPointInAll() {
        // Each geometry callback moves the content under a point.
        var travel = DragTravel()
        travel.began(at: 1_000)
        let steps = (1...4).map { travel.moved(to: 1_000 - 0.4 * Double($0)) }
        #expect(steps == [false, false, true, true])
    }

    @Test func aDragBackCountsFromTheNewestPointItReached() {
        // Pulled past the end first, then back toward older messages.
        var travel = DragTravel()
        travel.began(at: 1_000)
        let pastTheEnd = travel.moved(to: 1_050)
        let back = travel.moved(to: 1_030)
        #expect(!pastTheEnd)
        #expect(back)
    }

    @Test func aDragTowardNewerMessagesIsNotOne() {
        var travel = DragTravel()
        travel.began(at: 1_000)
        let nudge = travel.moved(to: 1_000.5)
        let newer = travel.moved(to: 1_200)
        #expect(!nudge)
        #expect(!newer)
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
