import XCTest

extension XCUIApplication {
    /// Scrolls until `element` sits above the page's bottom bar (the merge or comment strip),
    /// where a tap reaches it rather than the bar over it.
    func reveal(_ element: XCUIElement, clearance: CGFloat = 160, swipes: Int = 10) {
        for _ in 0..<swipes {
            if element.exists, element.isHittable, element.frame.maxY < frame.maxY - clearance { return }
            swipeUp()
        }
    }

    /// Drags the page down until `element` sits clear of the navigation bar at the top.
    func lower(_ element: XCUIElement, below top: CGFloat = 240) {
        for _ in 0..<4 where element.exists && element.frame.minY < top {
            let start = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
            start.press(forDuration: 0.05, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)))
        }
    }
}

extension XCUIApplication {
    /// Taps the button named `identifier` on a long settings page, scrolling it into view first:
    /// down the page, then back up when it lies above.
    func tapScrolled(_ identifier: String) {
        let button = buttons[identifier]
        for _ in 0..<4 where !(button.exists && button.isHittable) { swipeUp() }
        for _ in 0..<8 where !(button.exists && button.isHittable) { swipeDown() }
        button.tap()
    }
}
