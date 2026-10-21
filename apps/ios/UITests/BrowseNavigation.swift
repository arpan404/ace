import XCTest

extension XCUIApplication {
    @MainActor func openAgents() {
        XCTAssertTrue(buttons["thread.work"].waitForExistence(timeout: 10))
        buttons["thread.work"].tap()
        XCTAssertTrue(buttons["thread.agents"].waitForExistence(timeout: 10))
        buttons["thread.agents"].tap()
    }
    /// The inbox's detached compose button in the tab bar.
    var newThreadButton: XCUIElement { tabBars.buttons["New thread"].firstMatch }
    /// Browse ace: a long press on the Settings button offers it until Settings lists the tools.
    @MainActor func openLibrary() {
        XCTAssertTrue(buttons["inbox.settings"].waitForExistence(timeout: 10))
        buttons["inbox.settings"].press(forDuration: 1)
        XCTAssertTrue(buttons["inbox.library"].waitForExistence(timeout: 10))
        buttons["inbox.library"].tap()
    }
    @MainActor func openBrowseDestination(_ identifier: String) {
        if !buttons[identifier].exists { openLibrary() }
        XCTAssertTrue(buttons[identifier].waitForExistence(timeout: 10))
        buttons[identifier].tap()
    }
}
