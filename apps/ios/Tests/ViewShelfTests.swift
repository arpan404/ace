import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct ViewShelfTests {
    private final class View {}

    @Test func aPageScrolledBackIntoViewGetsItsLoadedViewAndHeightBack() {
        let shelf = ViewShelf<View>()
        let view = View()
        shelf.remember(height: 412, for: "chart")
        shelf.put(view, for: "chart")
        #expect(shelf.height("chart") == 412)
        #expect(shelf.take("chart") === view)
        // On screen again, the view is the row's alone until it leaves.
        #expect(shelf.take("chart") == nil)
        #expect(shelf.height("chart") == 412)
    }

    @Test func theLongestKeptViewsGoFirstPastTheLimit() {
        let shelf = ViewShelf<View>(maxKept: 2)
        let first = View(), second = View(), third = View()
        shelf.put(first, for: "a")
        shelf.put(second, for: "b")
        shelf.put(third, for: "c")
        #expect(shelf.take("a") == nil)
        #expect(shelf.take("b") === second)
        #expect(shelf.take("c") === third)
    }

    @Test func leavingTheWindowReleasesRenderersAndRejectsLateDismantles() {
        let shelf = ViewShelf<View>(maxKept: 40)
        let keep = View()
        shelf.put(keep, for: "overlap", owner: "block-400")

        let resident = (400..<800).map { "block-\($0)" }
        for index in 0..<38 {
            let owner = "block-\(index)"
            shelf.put(View(), for: "answer-\(index)", owner: owner)
        }
        var departing: View? = View()
        weak var retired = departing
        if let departing { shelf.put(departing, for: "departing", owner: "block-100") }
        departing = nil
        #expect(retired != nil)

        shelf.keepOwners(resident)
        shelf.put(View(), for: "late", owner: "block-101")

        print("Cached views after a 400-row window moved: \(shelf.keptCount)")
        #expect(retired == nil)
        #expect(shelf.keptCount == 1)
        #expect(shelf.take("overlap") === keep)
        #expect(shelf.take("late") == nil)
    }

    @Test func heightsOutliveTheirViewsUpToTheirOwnLimit() {
        let shelf = ViewShelf<View>(maxHeights: 2, maxKept: 1)
        shelf.remember(height: 100, for: "a")
        shelf.remember(height: 200, for: "b")
        shelf.remember(height: 210, for: "b")
        #expect(shelf.height("a") == 100)
        #expect(shelf.height("b") == 210)
        shelf.remember(height: 300, for: "c")
        #expect(shelf.height("a") == nil)
        #expect(shelf.height("c") == 300)
    }

    @Test func aPageIsKeyedByItsContent() {
        let chart = "<html><body>bars</body></html>"
        #expect(CanvasPage(document: chart).id == CanvasPage(document: chart).id)
        #expect(CanvasPage(document: chart).id != CanvasPage(document: chart + " ").id)
    }
}
