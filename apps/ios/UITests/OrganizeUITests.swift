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
        sleep(1)
        screenshot("row-menu")
        XCTAssertTrue(app.buttons["Move to project…"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Delete thread"].exists)
        XCTAssertTrue(app.buttons["Select"].exists)
        screenshot("row-menu")
        // The fixture keeps what earlier runs did: mark it read first if it is unread.
        if app.buttons["Mark read"].exists {
            app.buttons["Mark read"].tap()
            wait(for: [expectation(for: NSPredicate(format: "NOT (label CONTAINS 'Done')"), evaluatedWith: done)], timeout: 10)
            done.press(forDuration: 1.2)
        }
        // Mark unread: the finished row says Done again.
        let unread = app.buttons["Mark unread"]
        XCTAssertTrue(unread.waitForExistence(timeout: 5))
        unread.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        let saysDone = NSPredicate(format: "label CONTAINS 'Done'")
        wait(for: [expectation(for: saysDone, evaluatedWith: done)], timeout: 10)

        // Delete asks first, in red words, and Cancel leaves the thread.
        done.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Delete thread"].waitForExistence(timeout: 5))
        app.buttons["Delete thread"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.firstMatch.label.contains("Delete"))
        screenshot("delete-question")
        app.alerts.firstMatch.buttons["Cancel"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 5))

        // Move opens the machine's projects.
        done.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Move to project…"].waitForExistence(timeout: 5))
        app.buttons["Move to project…"].tap()
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
        XCTAssertTrue(app.buttons["Delete thread"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Move to project…"].exists)
        XCTAssertTrue(app.buttons["Turn off auto-settle"].exists)
        screenshot("thread-menu")
    }

    func testSelectModeArchivesSeveralThreadsWithOneUndo() throws {
        let app = launch()
        app.revealRow("thread.ios-done")
        app.buttons["inbox.select"].tap()
        XCTAssertTrue(app.buttons["select.done"].waitForExistence(timeout: 5))
        // Any two rows the list shows: picking is the system's own check circle.
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'thread.ios-'"))
        XCTAssertTrue(rows.element(boundBy: 1).waitForExistence(timeout: 10))
        // Each row's title, the start of its label (the age after it moves on).
        let picked = [rows.element(boundBy: 0).label, rows.element(boundBy: 1).label].map { $0.components(separatedBy: ",")[0] }
        rows.element(boundBy: 0).tap()
        rows.element(boundBy: 1).tap()
        XCTAssertTrue(app.staticTexts["2 selected"].waitForExistence(timeout: 5))
        screenshot("select-mode")
        app.buttons["select.archive"].tap()
        let undo = app.buttons["inbox.undoArchive"]
        XCTAssertTrue(undo.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Archived 2 threads"].exists)
        screenshot("select-archived")
        undo.tap()
        // Both come back with one Undo.
        for title in picked {
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
            app.bringToMiddle(row)
            XCTAssertTrue(row.exists, title)
        }
    }

    func testSearchEverythingFindsCommandsThreadsAndMessages() throws {
        let app = launch()
        app.revealRow("thread.ios-done")
        app.buttons["inbox.search"].tap()
        // Before a query: the commands, ready to run.
        XCTAssertTrue(app.buttons["search.command.new-thread"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["search.command.settings:appearance"].exists)
        screenshot("search-start")
        app.typeText("relay")
        XCTAssertTrue(app.buttons["search.filter.kind"].waitForExistence(timeout: 10))
        let hit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.thread.' OR identifier BEGINSWITH 'search.hit.'")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 15))
        sleep(2)
        screenshot("search-results")
        hit.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        // The query is remembered for next time.
        app.terminate()
        let again = launch()
        again.revealRow("thread.ios-done")
        again.buttons["inbox.search"].tap()
        XCTAssertTrue(again.buttons["search.recent.relay"].waitForExistence(timeout: 10))
        screenshot("search-recent")
    }

    func testAnArchivedSearchHitOpensAsTheMainPageItsComposerSendsTo() throws {
        let app = launch()
        app.revealRow("thread.ios-done")
        app.buttons["inbox.search"].tap()
        XCTAssertTrue(app.buttons["search.command.new-thread"].waitForExistence(timeout: 10))
        app.typeText("Archived task 7")
        let hit = app.buttons["search.thread.ios-archived-06"]
        XCTAssertTrue(hit.waitForExistence(timeout: 15))
        hit.tap()
        // The thread is the main page, as a row tap opens it: no Settings sheet over the old one.
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["settings.close"].exists, "opened inside Settings, apart from the main page")
        let title = app.descendants(matching: .any)["thread.title"].firstMatch
        XCTAssertTrue(title.label.contains("Archived task 7"), title.label)
        screenshot("archived-hit-opened")
    }

    func testAnAceLinkOpensItsThread() throws {
        let app = launch()
        app.revealRow("thread.ios-done")
        app.open(URL(string: "ace://thread/ios-done")!)
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["thread.title"].exists || app.otherElements["thread.title"].exists)
        screenshot("link-opened")
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
