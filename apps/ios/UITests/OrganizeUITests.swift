import XCTest

/// Every thread action is reachable from a visible control, against the local spike fixture:
/// the row's long-press preview and menu (an accelerator), the open thread's ⋯, and Select mode
/// with its bar of words. `ACE_IOS_SHOTS` (a folder) also saves each screenshot there.
@MainActor final class OrganizeUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }

    func testALongPressPreviewsTheThreadAboveItsSharedActions() throws {
        let app = launch()
        let done = app.revealRow("thread.ios-done")
        done.press(forDuration: 1.2)
        XCTAssertTrue(app.otherElements["thread.preview"].waitForExistence(timeout: 5) || app.staticTexts[done.label].exists)
        XCTAssertTrue(app.buttons["thread.action.move"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["thread.action.delete"].exists)
        XCTAssertTrue(app.buttons["thread.action.select"].exists)
        screenshot("row-menu")
        // Mark unread: the finished row says Done again.
        let unread = app.buttons["thread.action.unread"]
        XCTAssertTrue(unread.exists)
        unread.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        let saysDone = NSPredicate(format: "label CONTAINS 'Done'")
        wait(for: [expectation(for: saysDone, evaluatedWith: done)], timeout: 10)

        // Delete asks first, in red words, and Cancel leaves the thread.
        done.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["thread.action.delete"].waitForExistence(timeout: 5))
        app.buttons["thread.action.delete"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.firstMatch.label.contains("Delete"))
        screenshot("delete-question")
        app.alerts.firstMatch.buttons["Cancel"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 5))

        // Move opens the machine's projects.
        done.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["thread.action.move"].waitForExistence(timeout: 5))
        app.buttons["thread.action.move"].tap()
        XCTAssertTrue(app.buttons["move.close"].waitForExistence(timeout: 10))
        sleep(2)
        screenshot("move-sheet")
        app.buttons["move.close"].tap()
    }

    func testTheOpenThreadsMenuOffersTheSameActions() throws {
        let app = launch()
        app.revealRow("thread.ios-done").tap()
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        menu.tap()
        XCTAssertTrue(app.buttons["thread.action.delete"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["thread.action.move"].exists)
        XCTAssertTrue(app.buttons["thread.action.auto-settle-off"].exists)
        screenshot("thread-menu")
    }

    func testSelectModeArchivesSeveralThreadsWithOneUndo() throws {
        let app = launch()
        app.revealRow("thread.ios-done")
        app.buttons["inbox.select"].tap()
        XCTAssertTrue(app.buttons["select.done"].waitForExistence(timeout: 5))
        let first = app.descendants(matching: .any)["thread.ios-done"].firstMatch
        let second = app.descendants(matching: .any)["thread.ios-tree"].firstMatch
        app.bringToMiddle(first)
        first.tap()
        app.bringToMiddle(second)
        second.tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))
        screenshot("select-mode")
        app.buttons["select.archive"].tap()
        let undo = app.buttons["inbox.undoArchive"]
        XCTAssertTrue(undo.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Archived 2 threads"].exists)
        screenshot("select-archived")
        undo.tap()
        XCTAssertTrue(app.buttons["thread.ios-done"].waitForExistence(timeout: 15))
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-organize-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("organize-\(name).png"))
        }
    }
}
