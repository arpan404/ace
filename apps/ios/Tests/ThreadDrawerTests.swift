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
        #expect(ThreadDrawer.progress(from: 0, translation: 161, width: 322, limit: 1) == 0.5)
        #expect(ThreadDrawer.progress(from: 0, translation: -40, width: 322, limit: 1) == 0)
        #expect(ThreadDrawer.progress(from: 1, translation: -161, width: 322, limit: 1) == 0.5)
        #expect(ThreadDrawer.progress(from: 1, translation: 80, width: 322, limit: 1) == 1)
        #expect(ThreadDrawer.settles(progress: 0.6, velocity: 0, full: 1.25) == .open)
        #expect(ThreadDrawer.settles(progress: 0.4, velocity: 0, full: 1.25) == .closed)
        // A quick flick goes its way however little the list moved, never across the window.
        #expect(ThreadDrawer.settles(progress: 0.1, velocity: 900, full: 1.25) == .open)
        #expect(ThreadDrawer.settles(progress: 0.9, velocity: -900, full: 1.25) == .closed)
        #expect(ThreadDrawer.settles(progress: 1, velocity: 900, full: 1.25) == .open)
    }

    @Test func pullingTheListHardPastItsWidthTakesItAcrossTheWholeWindow() {
        let window: CGFloat = 402
        let width = ThreadDrawer.listWidth(window: window), full = ThreadDrawer.full(window: window)
        #expect(abs(full * width - window) < 0.001)
        // The pull goes on past the list's width, up to the window's.
        #expect(ThreadDrawer.progress(from: 1, translation: width, width: width, limit: full) == full)
        // Past halfway to the window, or flicked on, it settles across the window.
        #expect(ThreadDrawer.settles(progress: 1 + (full - 1) * 0.6, velocity: 0, full: full) == .full)
        #expect(ThreadDrawer.settles(progress: 1.01, velocity: 900, full: full) == .full)
        // A short pull goes back beside the page; flicked back from the pull, the list closes.
        #expect(ThreadDrawer.settles(progress: 1 + (full - 1) * 0.3, velocity: 0, full: full) == .open)
        #expect(ThreadDrawer.settles(progress: full, velocity: -900, full: full) == .closed)

        // Across the window the list is the window's width and the page is out of sight.
        let across = ThreadDrawer.placement(.page, progress: full, window: window, reduceMotion: false)
        #expect(across.listWidth == window && across.listOffset == 0 && abs(across.pageOffset - window) < 0.001)
        // Mid-pull the list keeps its width while the page follows the finger.
        let pulling = ThreadDrawer.placement(.page, progress: 1 + (full - 1) / 2, window: window, reduceMotion: false)
        #expect(pulling.listWidth == width && pulling.pageOffset > width && pulling.pageOffset < window && pulling.dim == 1)

        var drawer = ThreadDrawer()
        drawer.settle(.full, in: .page)
        #expect(drawer.isOpen && drawer.stop == .full)
        // Out of sight, the page takes no taps; the list's rows bring it back.
        #expect(!ThreadDrawer.closerShown(.page, stop: .full, held: nil))
        #expect(!drawer.pick(open, open: open, in: .page).opens && drawer.stop == .closed)
        // Only an open page has a drawer to rest across.
        drawer.settle(.full, in: .list)
        #expect(drawer.stop == .closed)
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
        hold.begin(from: 1, full: 1.25)
        hold.move(-322 * 1.5, width: 322)
        #expect(hold.progress == 0)
        // The dimmed thread stays to take the end of the drag with the list all the way in.
        #expect(ThreadDrawer.closerShown(.page, stop: .open, held: hold.progress))
        #expect(hold.release(velocity: 0) == .closed)
        #expect(hold.progress == nil)
        // Its end, after the system cancelled the drag, changes nothing more.
        #expect(hold.release(velocity: 0) == nil)
    }

    @MainActor @Test func aCancelledDragSettlesWhereTheFingerLeftIt() {
        let hold = DrawerHold()
        hold.begin(from: 0, full: 1.25)
        hold.move(250, width: 322)
        #expect(hold.release(velocity: 0) == .open)
        #expect(!ThreadDrawer.closerShown(.page, stop: .closed, held: hold.progress))
    }

    @MainActor @Test func oneHardSwipeFromTheEdgeCanTakeTheListAcrossTheWindow() {
        let hold = DrawerHold()
        hold.begin(from: 0, full: 1.25)
        hold.move(322 * 1.2, width: 322)
        #expect(hold.release(velocity: 0) == .full)
    }
}
