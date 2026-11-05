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
        // Snoozed threads wait on the Snoozed tab, out of the Inbox.
        XCTAssertFalse(app.buttons["thread.ios-snoozed"].exists)
        let inboxTab = app.buttons["threads.tab.inbox"].firstMatch
        let snoozedTab = app.buttons["threads.tab.snoozed"].firstMatch
        let settledTab = app.buttons["threads.tab.settled"].firstMatch
        snoozedTab.tap()
        XCTAssertTrue(app.buttons["thread.ios-snoozed"].waitForExistence(timeout: 10))
        screenshot("inbox-snoozed")
        inboxTab.tap()

        // Trailing swipe: Snooze asks until when; a snoozed row offers Wake instead.
        let tree = app.buttons["thread.ios-tree"]
        app.bringToMiddle(tree)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
        app.buttons["Snooze"].tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 5))
        screenshot("inbox-snooze")
        app.buttons["1 hour"].tap()
        // The snoozed row leaves the Inbox for the Snoozed tab, where it says when it wakes.
        XCTAssertTrue(tree.waitForNonExistence(timeout: 15))
        snoozedTab.tap()
        XCTAssertTrue(tree.waitForExistence(timeout: 10))
        XCTAssertTrue(tree.label.contains("Until"), tree.label)
        app.bringToMiddle(tree)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Wake"].waitForExistence(timeout: 5))
        app.buttons["Wake"].tap()
        XCTAssertTrue(tree.waitForNonExistence(timeout: 10), "awake, it leaves Snoozed")
        inboxTab.tap()

        // Settle moves a finished thread off the list; Undo, inside its five seconds, brings it back.
        let done = app.buttons["thread.ios-done"]
        app.bringToMiddle(done)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        let undoSettle = app.buttons["inbox.undoSettle"]
        XCTAssertTrue(undoSettle.waitForExistence(timeout: 10))
        XCTAssertTrue(done.waitForNonExistence(timeout: 10))
        undoSettle.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // Left alone, the toast goes and the thread waits on the Settled tab, which unsettles it.
        app.bringToMiddle(done)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        XCTAssertTrue(undoSettle.waitForExistence(timeout: 10))
        XCTAssertTrue(undoSettle.waitForNonExistence(timeout: 10), "the Undo toast goes by itself")
        settledTab.tap()
        screenshot("inbox-settled")
        app.bringToMiddle(done)
        XCTAssertTrue(done.isHittable, "the settled thread is on the Settled tab")
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Unsettle"].waitForExistence(timeout: 5))
        app.buttons["Unsettle"].tap()
        XCTAssertTrue(done.waitForNonExistence(timeout: 10), "unsettled, it leaves Settled")
        inboxTab.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // The leading swipe pins; Archive lives in the long-press menu, with its own Undo.
        app.bringToMiddle(done)
        done.swipeRight()
        XCTAssertTrue(app.buttons["Pin"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Archive"].exists, "the leading swipe only pins")
        done.swipeLeft()
        done.press(forDuration: 1.0)
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
