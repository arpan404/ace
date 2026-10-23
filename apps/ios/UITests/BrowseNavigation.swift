import XCTest

extension XCUIApplication {
    /// The agent tree, from the thread's ⋯ menu.
    @MainActor func openAgents() {
        XCTAssertTrue(buttons["thread.menu"].waitForExistence(timeout: 10))
        buttons["thread.menu"].tap()
        XCTAssertTrue(buttons["thread.agents"].waitForExistence(timeout: 10))
        buttons["thread.agents"].tap()
    }
    /// The inbox's New thread button, the round tab at the tab bar's trailing end.
    var newThreadButton: XCUIElement { tabBars.buttons["New thread"].firstMatch }
    /// Waits for an inbox row and scrolls until it shows: the fixture lists more threads than fit.
    @MainActor @discardableResult func revealRow(_ identifier: String, timeout: TimeInterval = 30) -> XCUIElement {
        XCTAssertTrue(buttons["inbox.settings"].waitForExistence(timeout: timeout))
        let row = buttons[identifier]
        bringToMiddle(row)
        XCTAssertTrue(row.isHittable, "\(identifier) never showed in the inbox")
        return row
    }
    /// Drags the list without letting it coast until `element` sits clear of the floating header
    /// and the tab bar. A swipe coasts on, and a tap made before it stops lands on whichever row
    /// slid under the finger.
    /// The drag runs down the element's own column: beside an iPad's open thread the list is not
    /// in the middle of the window.
    @MainActor func bringToMiddle(_ element: XCUIElement, attempts: Int = 30) {
        for attempt in 0..<attempts {
            // A row the lazy list hasn't loaded has no frame to read yet; its list is the one
            // under the inbox's own Settings button.
            let exists = element.exists
            let frame = exists ? element.frame : .zero
            let column = exists ? frame : buttons["inbox.settings"].exists ? buttons["inbox.settings"].frame : self.frame
            let x = self.frame.width > 0 ? min(max(column.midX / self.frame.width, 0.05), 0.95) : 0.5
            let lower = coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.72))
            let upper = coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.38))
            let visible = exists && frame.minY > self.frame.height * 0.2 && frame.maxY < self.frame.height * 0.82
            if visible && element.isHittable { return }
            // Above: drag down. Below: drag up. Not loaded yet: look further down the list first,
            // then back up it, since the row may have scrolled off either way.
            let above = exists ? frame.maxY <= self.frame.height * 0.2 : attempt >= attempts / 2
            if above {
                upper.press(forDuration: 0.1, thenDragTo: lower, withVelocity: .slow, thenHoldForDuration: 0.2)
            } else {
                lower.press(forDuration: 0.1, thenDragTo: upper, withVelocity: .slow, thenHoldForDuration: 0.2)
            }
        }
    }
    /// Opens Settings from the inbox, scrolled so the machine tools show.
    @MainActor func openSettings() {
        XCTAssertTrue(buttons["inbox.settings"].waitForExistence(timeout: 10))
        buttons["inbox.settings"].tap()
        XCTAssertTrue(buttons["settings.machines"].waitForExistence(timeout: 10))
        for _ in 0..<4 where !buttons["library.projects"].isHittable { swipeUp() }
    }
    /// A row of Settings, opened from the inbox when Settings isn't showing yet. `inbox.settings`
    /// only opens it; `inbox.machines` opens Settings › Machines.
    @MainActor func openBrowseDestination(_ identifier: String) {
        let target = identifier == "inbox.machines" ? "settings.machines" : identifier
        if !buttons[target].exists || target == "inbox.settings" {
            XCTAssertTrue(buttons["inbox.settings"].waitForExistence(timeout: 10))
            buttons["inbox.settings"].tap()
            XCTAssertTrue(buttons["settings.machines"].waitForExistence(timeout: 10))
        }
        guard target != "inbox.settings" else { return }
        for _ in 0..<6 where !buttons[target].isHittable { swipeUp() }
        XCTAssertTrue(buttons[target].waitForExistence(timeout: 10))
        buttons[target].tap()
    }
    /// The Changes sheet's row for `path`. The first file opens on its own, and a long diff pushes
    /// the rows after it out of the list, so that file is closed first.
    @MainActor func changesFile(_ path: String) -> XCUIElement {
        let first = buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        if first.identifier != "changes.file.\(path)" && first.value as? String == "Open" { first.tap() }
        return buttons["changes.file.\(path)"]
    }
    /// Closes whichever redesigned sheet is on top with its X.
    @MainActor func closeSheet() {
        for id in ["modelSheet.close", "changes.close", "agents.close", "newThread.close", "settings.close"] where buttons[id].exists {
            buttons[id].tap()
            return
        }
        XCTFail("No sheet to close")
    }
}
