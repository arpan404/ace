import XCTest

/// Files against the fixture's `ios-files` thread (`scripts/files-scenario.ts`): downloading a
/// folder as an archive, quick open with a `:line`, the open-files switcher, and a 3 MB log read,
/// searched and edited in parts. Uploading goes
/// through the system document picker, which runs outside the app; its bridge half is covered
/// by `bridge/checkout-transfers.test.ts`. `ACE_IOS_SHOTS` keeps each screen as a PNG.
@MainActor final class FilesTransferUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testFolderDownloadQuickOpenAndOpenFiles() {
        let app = launch()
        app.revealRow("thread.ios-files").tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        let files = app.threadMenuItem("thread.files")
        XCTAssertTrue(files.waitForExistence(timeout: 10)); files.tap()

        let manage = app.buttons["files.manage"]
        XCTAssertTrue(manage.waitForExistence(timeout: 20)); manage.tap()
        XCTAssertTrue(app.buttons["Upload files…"].waitForExistence(timeout: 5))
        capture("manage")
        app.buttons["Download folder…"].tap()
        let start = app.buttons["download.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        wait(for: [expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: start)], timeout: 20)
        capture("download-preview")
        start.tap()
        XCTAssertTrue(app.buttons["download.share"].waitForExistence(timeout: 60))
        capture("download-saved")
        app.buttons["Close"].tap()

        // Quick open: a path fragment with a line.
        let search = app.searchFields.firstMatch
        if !search.waitForExistence(timeout: 3) { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap()
        search.typeText("outbox:3")
        let hit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.'")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 15))
        capture("quick-open")
        hit.tap()
        XCTAssertTrue(app.buttons["files.open"].waitForExistence(timeout: 15))
        capture("file-open")
        app.buttons["files.open"].tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 10))
        capture("open-files")
        app.buttons["Done"].firstMatch.tap()

        // A 3 MB log reads in parts.
        app.navigationBars.buttons.element(boundBy: 0).tap() // back to the tree
        if !search.waitForExistence(timeout: 3) { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap()
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12) + "replay-soak")
        let log = app.buttons["search.logs/replay-soak.log"]
        XCTAssertTrue(log.waitForExistence(timeout: 15)); log.tap()
        let pages = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'read in parts'")).firstMatch
        XCTAssertTrue(pages.waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '000001 replay'")).firstMatch.waitForExistence(timeout: 10))
        capture("large-file")

        // Find reads on past the first part to a line it didn't hold.
        app.buttons["file.large.find"].tap()
        let query = app.textFields["file.large.query"]
        XCTAssertTrue(query.waitForExistence(timeout: 5))
        query.typeText("010000 replay")
        app.buttons["file.large.next"].tap()
        let count = app.staticTexts["file.large.count"]
        wait(for: [expectation(for: NSPredicate(format: "label BEGINSWITH '1 of 1'"), evaluatedWith: count)], timeout: 60)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '010000 replay'")).firstMatch.waitForExistence(timeout: 10))
        capture("large-find")
        app.buttons["file.large.find"].tap()

        // One part opens on its own and saves into the file.
        let edit = app.buttons["file.large.edit.0"]
        for _ in 0..<12 where !edit.isHittable { app.swipeDown() }
        XCTAssertTrue(edit.waitForExistence(timeout: 10)); edit.tap()
        let save = app.buttons["file.part.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["file.part.find"].exists, "find works while editing a part")
        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText("PHONEEDIT ")
        capture("large-edit")
        save.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'PHONEEDIT'")).firstMatch.waitForExistence(timeout: 60), "the saved part reads back")
        capture("large-saved")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "files-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("files-\(name).png"))
        }
    }
}
