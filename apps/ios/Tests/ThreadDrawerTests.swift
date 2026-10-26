import Testing
import SwiftUI
@testable import Ace

@Suite struct ThreadDrawerTests {
    private let open = InboxKey(machineId: "m", id: "a")
    private let other = InboxKey(machineId: "m", id: "b")
    private let child = InboxKey(machineId: "m", id: "child")

    @Test func aCompactWindowGivesTheOpenThreadTheWholeWindowAndTheListFillsItWhenNoneIsOpen() {
        #expect(ThreadDrawer.layout(.compact, path: [.thread(open)]) == .page)
        #expect(ThreadDrawer.layout(.compact, path: [.thread(open), .thread(child)]) == .page)
        #expect(ThreadDrawer.layout(.compact, path: []) == .list)
        // Regular keeps the list beside the thread and has no drawer at all.
        #expect(ThreadDrawer.layout(.regular, path: [.thread(open)]) == .beside)
        var drawer = ThreadDrawer()
        drawer.open(in: .beside)
        #expect(!drawer.isOpen)
        drawer.open(in: .list)
        #expect(!drawer.isOpen)
    }

    @Test func theSidebarButtonOpensTheDrawerOverTheThreadPushingItAsideDimmed() {
        var drawer = ThreadDrawer()
        drawer.open(in: .page)
        #expect(drawer.isOpen)
        let width = ThreadDrawer.listWidth(window: 402)
        let out = ThreadDrawer.placement(.page, progress: 1, window: 402, reduceMotion: false)
        #expect(out.listOffset == 0 && out.listWidth == width)
        // The page moves aside by the list's width, still in sight at the trailing edge.
        #expect(out.pageOffset == width && out.pageOffset < 402)
        #expect(out.dim == 1 && out.rounded)
        let closed = ThreadDrawer.placement(.page, progress: 0, window: 402, reduceMotion: false)
        #expect(closed.pageOffset == 0 && closed.listOffset == -width && closed.dim == 0 && !closed.rounded)
    }

    @Test func theListIsAboutFourFifthsOfAPhoneAndNoWiderThanTheListBesideAThread() {
        #expect(ThreadDrawer.listWidth(window: 402) == 322)
        #expect(ThreadDrawer.listWidth(window: 600) == ThreadColumns.listWidth.max)
    }

    @Test func withReduceMotionTheListFadesInOverTheThreadWithoutSliding() {
        let half = ThreadDrawer.placement(.page, progress: 0.5, window: 402, reduceMotion: true)
        #expect(half.pageOffset == 0 && half.listOffset == 0)
        #expect(half.listOpacity == 0.5 && half.dim == 0.5)
    }

    @Test func withNothingOpenTheListFillsTheWindowAndTheFirstThreadSlidesInFromTheTrailingEdge() {
        let list = ThreadDrawer.placement(.list, progress: 0, window: 402, reduceMotion: false)
        #expect(list.listWidth == 402 && list.listOffset == 0 && list.listOpacity == 1)
        #expect(list.pageOffset == 402)
    }

    @Test func pickingAThreadTappingTheDimmedThreadOrArchivingItClosesTheDrawer() {
        var drawer = ThreadDrawer()
        drawer.open(in: .page)
        drawer.close()
        #expect(!drawer.isOpen)
        // Another thread in place of the open one (a pick, a notification, ⌘]).
        drawer.open(in: .page)
        drawer.follow(layout: .page, old: [.thread(open)], new: [.thread(other)])
        #expect(!drawer.isOpen)
        // The open thread closed: the list fills the window again.
        drawer.open(in: .page)
        drawer.follow(layout: .list, old: [.thread(open)], new: [])
        #expect(!drawer.isOpen)
    }

    @Test func widenedToRegularTheDrawerIsGoneAndNarrowedAgainTheThreadShowsWithItClosed() {
        var drawer = ThreadDrawer()
        drawer.open(in: .page)
        drawer.follow(layout: .beside, old: [.thread(open)], new: [.thread(open)])
        #expect(!drawer.isOpen)
        drawer.follow(layout: .page, old: [.thread(open)], new: [.thread(open)])
        #expect(!drawer.isOpen)
    }

    @Test func anEdgeSwipeOpensTheDrawerOnlyAtTheThreadsRootAndIsBackOverAPushedPage() {
        #expect(ThreadDrawer.edgeOpens(.page, path: [.thread(open)]))
        #expect(!ThreadDrawer.edgeOpens(.page, path: [.thread(open), .thread(child)]))
        #expect(!ThreadDrawer.edgeOpens(.list, path: []))
        #expect(!ThreadDrawer.edgeOpens(.beside, path: [.thread(open)]))
    }

    @Test func aDragFollowsTheFingerAndSettlesAtTheNearerEndUnlessFlicked() {
        #expect(ThreadDrawer.progress(from: false, translation: 161, width: 322) == 0.5)
        #expect(ThreadDrawer.progress(from: false, translation: -40, width: 322) == 0)
        #expect(ThreadDrawer.progress(from: true, translation: -161, width: 322) == 0.5)
        #expect(ThreadDrawer.progress(from: true, translation: 80, width: 322) == 1)
        #expect(ThreadDrawer.settlesOpen(progress: 0.6, velocity: 0))
        #expect(!ThreadDrawer.settlesOpen(progress: 0.4, velocity: 0))
        // A quick flick goes its way however little the list moved.
        #expect(ThreadDrawer.settlesOpen(progress: 0.1, velocity: 900))
        #expect(!ThreadDrawer.settlesOpen(progress: 0.9, velocity: -900))
    }

    @Test func theListCarriesTheTabsBesideAndOverAThreadButNotWhenItFillsTheWindow() {
        #expect(ThreadDrawer.listHoldsTabs(.beside))
        #expect(ThreadDrawer.listHoldsTabs(.page))
        #expect(!ThreadDrawer.listHoldsTabs(.list))
    }
}
