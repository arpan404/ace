import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct CanvasShelfTests {
    private final class View {}

    @Test func aPageScrolledBackIntoViewGetsItsLoadedViewAndHeightBack() {
        let shelf = CanvasShelf<View>()
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
        let shelf = CanvasShelf<View>(maxKept: 2)
        let first = View(), second = View(), third = View()
        shelf.put(first, for: "a")
        shelf.put(second, for: "b")
        shelf.put(third, for: "c")
        #expect(shelf.take("a") == nil)
        #expect(shelf.take("b") === second)
        #expect(shelf.take("c") === third)
    }

    @Test func heightsOutliveTheirViewsUpToTheirOwnLimit() {
        let shelf = CanvasShelf<View>(maxHeights: 2, maxKept: 1)
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
