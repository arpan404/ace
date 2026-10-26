import Testing
import SwiftUI
@testable import Ace

@Suite struct ThreadColumnsTests {
    private let open = InboxKey(machineId: "m", id: "a")
    private let child = InboxKey(machineId: "m", id: "child")

    @Test func aRegularWidthWindowShowsTheThreadListBesideTheOpenThread() {
        // iPad full screen, the unfolded iPhone Duo in landscape, an iPad mini in portrait.
        for width in [1180.0, 890, 744] {
            #expect(ThreadColumns.sideBySide(.regular, width: width))
            #expect(ThreadColumns.visibility(.regular, width: width, open: true) == .all)
        }
    }

    @Test func aCompactWindowStacksTheListAndTheThread() {
        // A phone, the folded Duo, a narrow iPad window.
        #expect(!ThreadColumns.sideBySide(.compact, width: 402))
        #expect(!ThreadColumns.sideBySide(.compact, width: 1000))
        #expect(ThreadColumns.compactColumn([.thread(open)]) == .detail)
        #expect(ThreadColumns.compactColumn([]) == .sidebar)
    }

    @Test func aRegularWindowTooNarrowForBothGivesTheOpenThreadTheWholeWidth() {
        // The unfolded Duo held upright: regular, but a list beside the thread would squeeze it.
        #expect(ThreadColumns.visibility(.regular, width: 626, open: true) == .detailOnly)
        #expect(ThreadColumns.visibility(.regular, width: 626, open: false) == .all)
    }

    @Test func narrowingTheWindowKeepsTheOpenThreadAndThePagesPushedOverIt() {
        // One path in every layout: the split reads its selection and detail from it, and the
        // collapsed stack is that same path.
        let path: [InboxRoute] = [.thread(open), .thread(child)]
        #expect(ThreadColumns.selection(path) == open)
        #expect(ThreadColumns.detail(path) == [.thread(child)])
        #expect(ThreadColumns.path(path, detail: ThreadColumns.detail(path)) == path)
        #expect(ThreadColumns.compactColumn(path) == .detail)
    }

    @Test func goingBackFromAChildInTheDetailColumnKeepsItsParentOpen() {
        let path: [InboxRoute] = [.thread(open), .thread(child)]
        #expect(ThreadColumns.path(path, detail: []) == [.thread(open)])
        #expect(ThreadColumns.path([], detail: [.thread(child)]) == [])
    }

    @Test func goingBackToTheListOnAPhoneClosesTheThreadWhicheverSignalComesFirst() {
        // The split view's report, then the list appearing.
        var back = BackToList()
        back.listDisappeared()
        let reportFirst = back.listReported(.compact)
        let thenShown = back.listAppeared(.compact)
        #expect(!reportFirst && thenShown)
        // The list appearing first, then the report: the order that left the row stuck open.
        back.listDisappeared()
        let shownFirst = back.listAppeared(.compact)
        let thenReported = back.listReported(.compact)
        #expect(!shownFirst && thenReported)
    }

    @Test func poppingABrowserOverTheThreadOrResizingTheWindowKeepsTheThreadOpen() {
        // A page popped over the thread: reported, but the list stays covered.
        var back = BackToList()
        back.listDisappeared()
        let popped = back.listReported(.compact)
        back.listDisappeared()
        // The window changing shape: the list appears with no report.
        let resized = back.listAppeared(.compact)
        #expect(!popped && !resized)
        // Beside the list (regular) neither ever closes the thread.
        var wide = BackToList()
        let wideReport = wide.listReported(.regular)
        let wideShown = wide.listAppeared(.regular)
        #expect(!wideReport && !wideShown)
    }

    @Test func aTapJustAfterARowActionOpensNothingButALaterOneDoes() {
        var taps = RowTapGuard()
        #expect(taps.opens(at: 100))
        taps.acted(at: 100)
        // The row sliding in under the finger takes the same touch.
        #expect(!taps.opens(at: 100.2))
        #expect(taps.opens(at: 100 + RowTapGuard.window))
    }

    @Test func besideTheListTheSidebarCarriesTheTabsAndAPhoneKeepsItsTabBar() {
        // Regular: Threads, Pull requests and New thread live in the sidebar; no tab bar at all.
        #expect(ThreadColumns.sidebarHoldsTabs(.regular))
        #expect(!ThreadColumns.showsTabBar(.regular, path: []))
        #expect(!ThreadColumns.showsTabBar(.regular, path: [.thread(open)]))
        // Compact: the tab bar is back, stepping aside while a page shows.
        #expect(!ThreadColumns.sidebarHoldsTabs(.compact))
        #expect(ThreadColumns.showsTabBar(.compact, path: []))
        #expect(!ThreadColumns.showsTabBar(.compact, path: [.thread(open)]))
    }

    @Test func besideTheListTheCardComposerAndTranscriptShareOneColumnsEdges() {
        let wide = ReadingColumn.bar(.regular)
        #expect(wide.card == wide.composer)
        #expect(wide.composer == ReadingColumn.textMargin)
        // Clear of the window's resize corner, which sits under the composer's trailing end.
        #expect(wide.bottom > ReadingColumn.bar(.compact).bottom)
        // A phone keeps its composer near the edge and the card tucked narrower than it.
        let phone = ReadingColumn.bar(.compact)
        #expect(phone.card > phone.composer)
        #expect(phone.composer < ReadingColumn.textMargin)
    }

    @Test func theListsHeaderStepsClearOfTheSidebarCornerAndTheWindowControlsOnly() {
        #expect(ThreadColumns.headerLead(.regular, windowControls: 0) > 0)
        // Beside the window's controls the header keeps clearly apart from them.
        #expect(ThreadColumns.headerLead(.compact, windowControls: 66) > ThreadColumns.headerLead(.regular, windowControls: 0))
        #expect(ThreadColumns.headerLead(.regular, windowControls: 66) == ThreadColumns.headerLead(.compact, windowControls: 66))
        // A phone, or a window without controls, keeps the bar's own place.
        #expect(ThreadColumns.headerLead(.compact, windowControls: 0) == 0)
    }

    @Test func nextAndPreviousThreadFollowTheListAndStopAtItsEnds() {
        let order = ["a", "b", "c"].map { InboxKey(machineId: "m", id: $0) }
        #expect(ThreadColumns.neighbour(of: order[0], in: order, step: 1) == order[1])
        #expect(ThreadColumns.neighbour(of: order[1], in: order, step: -1) == order[0])
        #expect(ThreadColumns.neighbour(of: order[2], in: order, step: 1) == nil)
        #expect(ThreadColumns.neighbour(of: nil, in: order, step: 1) == order[0])
        #expect(ThreadColumns.neighbour(of: nil, in: order, step: -1) == order[2])
        #expect(ThreadColumns.neighbour(of: nil, in: [], step: 1) == nil)
    }

    @Test func threadOrderSkipsClosedShelvesAndOpensAnUnsentRowsThread() {
        let key = { InboxKey(machineId: "m", id: $0) }
        let sections = [
            MergedInbox.Section(key: "settled", label: "Settled", rows: [key("done")]),
            MergedInbox.Section(key: "unsent", label: "Unsent", rows: [key("pending-1")]),
            MergedInbox.Section(key: "now", label: "", rows: [key("a"), key("b")]),
            MergedInbox.Section(key: "snoozed", label: "Snoozed", rows: [key("later")]),
        ]
        let thread: (InboxKey) -> InboxKey? = { $0.id == "pending-1" ? key("b") : $0 }
        #expect(ThreadColumns.order(sections, shelves: InboxShelves(), thread: thread) == [key("b"), key("a")])
        #expect(ThreadColumns.order(sections, shelves: InboxShelves(snoozed: true, settled: true), thread: thread)
                == [key("b"), key("a"), key("later"), key("done")])
    }
}
