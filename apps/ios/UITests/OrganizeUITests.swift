import XCTest

/// Every thread action is reachable from a visible control, against the local spike fixture:
/// the row's long-press preview and menu (an accelerator), the open thread's ⋯, and Select mode
/// with its bar of words. `ACE_IOS_SHOTS` (a folder) also saves each screenshot there.
@MainActor final class OrganizeUITests: XCTestCase, @unchecked Sendable {
    override func setUp() {
        continueAfterFailure = false
        // The list scrolls by portrait drags; the Duo can come up turned.
        XCUIDevice.shared.orientation = .portrait
    }
    /// The screen as each test ends, so a failure shows what was on it.
    override func tearDown() { screenshot("end-\(name.split(separator: " ").last?.dropLast() ?? "")") }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        // A fresh simulator asks once for notifications, after the first rows show; answer it so
        // it never covers the list.
        _ = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'thread.'")).firstMatch.waitForExistence(timeout: 30)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 6) { allow.tap() }
        return app
    }

    func testALongPressPreviewsTheThreadAboveItsSharedActions() throws {
        let app = launch()
        let done = reveal(app, "thread.ios-done")
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
        reveal(app, "thread.ios-done").tap()
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 15))
        menu.tap()
        // A short screen scrolls the menu to its organize section.
        for _ in 0..<4 where !app.buttons["Delete thread"].exists {
            let low = app.buttons["Skills and tools"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            low.press(forDuration: 0.05, thenDragTo: app.buttons["Changes"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
        }
        XCTAssertTrue(app.buttons["Delete thread"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Move to project…"].exists)
        XCTAssertTrue(app.buttons["Turn off auto-settle"].exists)
        screenshot("thread-menu")
    }

    func testSelectModeArchivesSeveralThreadsWithOneUndo() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.select"].waitForExistence(timeout: 30))
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
            for _ in 0..<20 where !row.isHittable {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.72))
                    .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.38)), withVelocity: .slow, thenHoldForDuration: 0.2)
            }
            XCTAssertTrue(row.exists, title)
        }
    }

    func testSearchEverythingFindsCommandsThreadsAndMessages() throws {
        let app = launch()
        reveal(app, "thread.ios-done")
        app.buttons["inbox.search"].tap()
        // Before a query: the commands, ready to run.
        XCTAssertTrue(app.buttons["search.command.new-thread"].waitForExistence(timeout: 10))
        screenshot("search-start")
        app.searchFields.firstMatch.tap()
        app.searchFields.firstMatch.typeText("relay")
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
        reveal(again, "thread.ios-done")
        again.buttons["inbox.search"].tap()
        XCTAssertTrue(again.buttons["search.recent.relay"].waitForExistence(timeout: 10))
        screenshot("search-recent")
    }

    func testAnArchivedSearchHitOpensAsTheMainPageItsComposerSendsTo() throws {
        let app = launch()
        reveal(app, "thread.ios-done")
        app.buttons["inbox.search"].tap()
        XCTAssertTrue(app.buttons["search.command.new-thread"].waitForExistence(timeout: 10))
        app.searchFields.firstMatch.tap()
        app.searchFields.firstMatch.typeText("Archived task 7")
        let hit = app.buttons["search.thread.ios-archived-06"]
        XCTAssertTrue(hit.waitForExistence(timeout: 15))
        hit.tap()
        // The thread is the main page, as a row tap opens it: no Settings sheet over the old one.
        XCTAssertTrue(pageTitle(app, "Archived task 7").waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["settings.close"].exists, "opened inside Settings, apart from the main page")
        screenshot("archived-hit-opened")
    }

    /// The link itself starts the app: it arrives before any machine is read, waits, and opens
    /// once the machine's list is in. Opened directly on arrival, it would find no machine.
    func testALinkThatColdLaunchesTheAppOpensOnceItsMachineIsReady() throws {
        let app = launch()
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10))
        // As a real cold start: the inbox is up before its machines are read.
        app.launchArguments.append("--spike-late-machines")
        app.open(URL(string: "ace://thread/ios-done")!)
        XCTAssertTrue(pageTitle(app, "Tighten the composer spacing").waitForExistence(timeout: 40))
        XCTAssertFalse(app.alerts.firstMatch.exists, "the link was refused instead of waiting")
        screenshot("link-cold-launch")
    }

    func testAnAceLinkOpensItsThread() throws {
        let app = launch()
        reveal(app, "thread.ios-done")
        app.open(URL(string: "ace://thread/ios-done")!)
        XCTAssertTrue(pageTitle(app, "Tighten the composer spacing").waitForExistence(timeout: 15))
        screenshot("link-opened")
    }

    /// Scrolls the list, in its middle, until the row sits in view. (The shared helper drags down
    /// the Settings button's column, which on the Duo is a rail beside the list.)
    @discardableResult private func reveal(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 30))
        let row = app.buttons[identifier]
        for attempt in 0..<30 {
            let frame = row.exists ? row.frame : .zero
            if row.exists, frame.minY > app.frame.height * 0.2, frame.maxY < app.frame.height * 0.82, row.isHittable { return row }
            let lower = app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.72))
            let upper = app.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.38))
            let above = row.exists ? frame.maxY <= app.frame.height * 0.2 : attempt >= 15
            if above { upper.press(forDuration: 0.1, thenDragTo: lower, withVelocity: .slow, thenHoldForDuration: 0.2) }
            else { lower.press(forDuration: 0.1, thenDragTo: upper, withVelocity: .slow, thenHoldForDuration: 0.2) }
        }
        XCTAssertTrue(row.isHittable, "\(identifier) never showed in the inbox")
        return row
    }

    /// The open thread's title in its bar.
    private func pageTitle(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'thread.title' AND label CONTAINS %@", title)).firstMatch
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
