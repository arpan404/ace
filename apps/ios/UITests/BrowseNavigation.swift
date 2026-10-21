import XCTest

extension XCUIApplication {
    @MainActor func openAgents() {
        XCTAssertTrue(buttons["thread.work"].waitForExistence(timeout: 10))
        buttons["thread.work"].tap()
        XCTAssertTrue(buttons["thread.agents"].waitForExistence(timeout: 10))
        buttons["thread.agents"].tap()
    }
    @MainActor func openBrowseDestination(_ identifier: String) {
        if !buttons[identifier].exists {
            XCTAssertTrue(buttons["inbox.library"].waitForExistence(timeout: 10))
            buttons["inbox.library"].tap()
        }
        XCTAssertTrue(buttons[identifier].waitForExistence(timeout: 10))
        buttons[identifier].tap()
    }
}
