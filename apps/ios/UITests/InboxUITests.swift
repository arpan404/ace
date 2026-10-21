import XCTest

/// The inbox against the local spike fixture: the Snoozed shelf, swipe actions, undo and offline.
@MainActor final class InboxUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testShelvesSwipesAndUndo() throws {
        let app = XCUIApplication()
        // `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects a fresh fixture; this test settles and snoozes.
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-tree"].waitForExistence(timeout: 25))
        screenshot("inbox")
        // Snoozed threads wait folded on their shelf at the end of the list.
        XCTAssertFalse(app.buttons["thread.ios-snoozed"].exists)
        let shelf = app.buttons["inbox.snoozed"].firstMatch
        reveal(shelf, in: app, up: true)
        shelf.tap()
        // Its rows open below the shelf, which may sit at the bottom edge.
        let napping = app.buttons["thread.ios-snoozed"]
        reveal(napping, in: app, up: true)
        XCTAssertTrue(napping.waitForExistence(timeout: 10))
        screenshot("inbox-snoozed")

        // Trailing swipe: Snooze asks until when; a snoozed row offers Wake instead.
        let tree = app.buttons["thread.ios-tree"]
        reveal(tree, in: app, up: false)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
        app.buttons["Snooze"].tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 5))
        screenshot("inbox-snooze")
        app.buttons["1 hour"].tap()
        // The row moves to the open Snoozed shelf at the end of the list.
        let moved = expectation(for: NSPredicate(format: "exists == false OR label CONTAINS 'Until'"), evaluatedWith: tree)
        wait(for: [moved], timeout: 15)
        reveal(tree, in: app, up: true)
        let snoozed = expectation(for: NSPredicate(format: "label CONTAINS 'Until'"), evaluatedWith: tree)
        wait(for: [snoozed], timeout: 15)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Wake"].waitForExistence(timeout: 5))
        app.buttons["Wake"].tap()
        // Fold the shelf again so the Settled shelf lands in view.
        if shelf.isHittable && (shelf.value as? String) == "Expanded" { shelf.tap() }

        // Settle moves a finished thread to the Settled shelf; Undo brings it back.
        let done = app.buttons["thread.ios-done"]
        reveal(done, in: app, up: true)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        XCTAssertTrue(app.buttons["inbox.undoSettle"].waitForExistence(timeout: 10))
        let settled = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: done)
        wait(for: [settled], timeout: 10)
        XCTAssertTrue(app.buttons["inbox.settled"].exists)
        screenshot("inbox-settled")
        app.buttons["inbox.undoSettle"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // Leading swipe archives, with its own Undo.
        reveal(done, in: app, up: true)
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

    /// Scrolls until `element` sits clear of the bars, then lets the list stop gliding: a touch
    /// while it still moves only stops the scroll.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, up: Bool) {
        let clear = app.frame.insetBy(dx: 0, dy: 130)
        for _ in 0..<8 where !(element.isHittable && clear.contains(element.frame)) {
            if up { app.swipeUp() } else { app.swipeDown() }
        }
        sleep(1)
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
