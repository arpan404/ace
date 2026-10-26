import Testing
import SwiftUI
@testable import Ace

@Suite struct ThreadDrawerTests {
    private let open = InboxKey(machineId: "m", id: "a")
    private let other = InboxKey(machineId: "m", id: "b")
    private let child = InboxKey(machineId: "m", id: "child")

    @Test func onlyAnOpenPageHasADrawerToOpen() {
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


    @Test func pickingTheOpenThreadsRowClosesTheDrawerWithoutOpeningItAgain() {
        var drawer = ThreadDrawer()
        drawer.open(in: .page)
        let same = drawer.pick(open, open: open, in: .page)
        #expect(!same.opens && !drawer.isOpen)
        drawer.open(in: .page)
        let next = drawer.pick(other, open: open, in: .page)
        #expect(next.opens && !drawer.isOpen)
    }

    @Test func aPickInACompactWindowEndsTheListsSearchButBesideTheThreadItStays() {
        var drawer = ThreadDrawer()
        drawer.open(in: .page)
        #expect(drawer.pick(other, open: open, in: .page).endsSearch)
        // The full-width list's search results, under the thread they open.
        #expect(drawer.pick(other, open: nil, in: .list).endsSearch)
        #expect(!drawer.pick(other, open: open, in: .beside).endsSearch)
    }

    @Test func theSidebarShortcutTogglesTheDrawer() {
        var drawer = ThreadDrawer()
        drawer.toggle(in: .page)
        #expect(drawer.isOpen)
        drawer.toggle(in: .page)
        #expect(!drawer.isOpen)
    }

    @MainActor @Test func dragTheDimmedThreadPastTheListsFullWidthAndItStillLetsGoClosed() {
        let hold = DrawerHold()
        hold.begin(from: true)
        hold.move(-322 * 1.5, width: 322)
        #expect(hold.progress == 0)
        // The dimmed thread stays to take the end of the drag with the list all the way in.
        #expect(ThreadDrawer.closerShown(.page, open: true, held: hold.progress))
        #expect(hold.release(velocity: 0) == false)
        #expect(hold.progress == nil)
        // Its end, after the system cancelled the drag, changes nothing more.
        #expect(hold.release(velocity: 0) == nil)
    }

    @MainActor @Test func aCancelledDragSettlesWhereTheFingerLeftIt() {
        let hold = DrawerHold()
        hold.begin(from: false)
        hold.move(250, width: 322)
        #expect(hold.release(velocity: 0) == true)
        #expect(!ThreadDrawer.closerShown(.page, open: false, held: hold.progress))
    }
}
