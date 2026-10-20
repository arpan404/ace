import XCTest

/// The inbox against the local spike fixture: folded Done/Snoozed, swipe actions, undo and offline.
@MainActor final class InboxUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testSettledFoldsOpenAndArchiveCanBeUndone() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike"]
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-tree"].waitForExistence(timeout: 25))
        XCTAssertFalse(app.buttons["thread.ios-done"].exists)
        screenshot("inbox")
        app.buttons["inbox.settled"].firstMatch.tap()
        XCTAssertTrue(app.buttons["thread.ios-done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["thread.ios-snoozed"].exists)
        screenshot("inbox-settled")
        app.buttons["thread.ios-tree"].swipeRight()
        XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
        app.buttons["Snooze"].tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 5))
        screenshot("inbox-snooze")
        app.buttons["1 hour"].tap()
        let snoozed = expectation(for: NSPredicate(format: "label CONTAINS 'Until'"), evaluatedWith: app.buttons["thread.ios-tree"])
        wait(for: [snoozed], timeout: 15)
        app.buttons["thread.ios-tree"].swipeRight()
        XCTAssertTrue(app.buttons["Wake"].waitForExistence(timeout: 5))
        app.buttons["Wake"].tap()
        app.buttons["thread.ios-done"].swipeLeft()
        XCTAssertTrue(app.buttons["Archive"].waitForExistence(timeout: 5))
        app.buttons["Archive"].tap()
        XCTAssertTrue(app.buttons["inbox.undoArchive"].waitForExistence(timeout: 10))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["thread.ios-done"])
        wait(for: [gone], timeout: 10)
        screenshot("inbox-archived")
        app.buttons["inbox.undoArchive"].tap()
        XCTAssertTrue(app.buttons["thread.ios-done"].waitForExistence(timeout: 10))
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
