import XCTest

/// The inbox against the local spike fixture: the Snoozed shelf, swipe actions, undo and offline.
@MainActor final class InboxUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testShelvesSwipesAndUndo() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        app.revealRow("thread.ios-tree")
        screenshot("inbox")
        // Snoozed threads wait folded on their shelf at the end of the list.
        XCTAssertFalse(app.buttons["thread.ios-snoozed"].exists)
        let shelf = app.buttons["inbox.snoozed"].firstMatch
        app.bringToMiddle(shelf)
        shelf.tap()
        XCTAssertTrue(app.buttons["thread.ios-snoozed"].waitForExistence(timeout: 10))
        screenshot("inbox-snoozed")

        // Trailing swipe: Snooze asks until when; a snoozed row offers Wake instead.
        let tree = app.buttons["thread.ios-tree"]
        app.bringToMiddle(tree)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
        app.buttons["Snooze"].tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 5))
        screenshot("inbox-snooze")
        app.buttons["1 hour"].tap()
        // The snoozed row moves to the open shelf at the end of the list and says when it wakes.
        var wakes = false
        for _ in 0..<15 where !wakes {
            sleep(1)
            wakes = tree.exists && tree.label.contains("Until")
            if !wakes { app.swipeUp() }
        }
        XCTAssertTrue(wakes)
        app.bringToMiddle(tree)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Wake"].waitForExistence(timeout: 5))
        app.buttons["Wake"].tap()

        // Settle moves a finished thread to the Settled shelf; Undo brings it back.
        let done = app.buttons["thread.ios-done"]
        app.bringToMiddle(done)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        XCTAssertTrue(app.buttons["inbox.undoSettle"].waitForExistence(timeout: 10))
        let settled = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: done)
        wait(for: [settled], timeout: 10)
        let settledShelf = app.buttons["inbox.settled"]
        for _ in 0..<4 where !settledShelf.exists { app.swipeUp() }
        XCTAssertTrue(settledShelf.exists)
        screenshot("inbox-settled")
        app.buttons["inbox.undoSettle"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // Leading swipe archives, with its own Undo.
        app.bringToMiddle(done)
        done.swipeRight()
        XCTAssertTrue(app.buttons["Archive"].waitForExistence(timeout: 5))
        app.buttons["Archive"].tap()
        XCTAssertTrue(app.buttons["inbox.undoArchive"].waitForExistence(timeout: 10))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: done)
        wait(for: [gone], timeout: 10)
        screenshot("inbox-archived")
        app.buttons["inbox.undoArchive"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
