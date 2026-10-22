import XCTest

extension XCUIApplication {
    /// The agent tree, from the thread's ⋯ menu.
    @MainActor func openAgents() {
        XCTAssertTrue(buttons["thread.menu"].waitForExistence(timeout: 10))
        buttons["thread.menu"].tap()
        XCTAssertTrue(buttons["thread.agents"].waitForExistence(timeout: 10))
        buttons["thread.agents"].tap()
    }
    /// The inbox's New thread button in the bottom toolbar.
    var newThreadButton: XCUIElement { buttons["inbox.compose"].firstMatch }
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
    /// Closes whichever redesigned sheet is on top with its X.
    @MainActor func closeSheet() {
        for id in ["modelSheet.close", "changes.close", "agents.close", "newThread.close", "settings.close"] where buttons[id].exists {
            buttons[id].tap()
            return
        }
        XCTFail("No sheet to close")
    }
}
