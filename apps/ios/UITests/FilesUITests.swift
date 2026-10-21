import XCTest

/// The Files screens against the spike fixture's `ios-files` thread (`scripts/files-scenario.ts`).
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves each screenshot
/// there as `files-<name>.png`.
@MainActor final class FilesUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheTreeLettersChangesAndAFileOpensWithItsChangedLines() throws {
        let app = launchIntoFiles()
        let outbox = app.buttons["file.apps/web/src/relay/outbox.ts"]
        // Folders holding a change start open, so the changed files show at once.
        XCTAssertTrue(outbox.waitForExistence(timeout: 15))
        XCTAssertTrue(outbox.label.contains("Modified"))
        XCTAssertTrue(app.buttons["file.apps/web/src/relay/legacy.ts"].label.contains("Deleted"))
        screenshot("tree")
        outbox.tap()
        let text = element(app, "preview.text")
        XCTAssertTrue(text.waitForExistence(timeout: 15))
        XCTAssertTrue((text.value as? String)?.contains("MAX_BUFFERED = 500") == true)
        screenshot("file")
        app.buttons["file.menu"].tap()
        XCTAssertTrue(app.buttons["file.changes"].waitForExistence(timeout: 5))
        screenshot("file-menu")
        app.buttons["file.changes"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["diff.view"].waitForExistence(timeout: 15))
        screenshot("file-changes")
    }

    func testAnEditIsSavedOverTheVersionThatWasOpened() throws {
        let app = launchIntoFiles()
        let readme = app.buttons["file.README.md"]
        for _ in 0..<8 where !readme.waitForExistence(timeout: 2) { app.swipeUp() }
        readme.tap()
        XCTAssertTrue(element(app, "preview.markdown").waitForExistence(timeout: 15))
        screenshot("markdown")
        app.buttons["file.edit"].tap()
        let text = element(app, "preview.text")
        XCTAssertTrue(text.waitForExistence(timeout: 10))
        text.tap()
        text.typeText("Edited on the phone. ")
        screenshot("editing")
        app.buttons["file.save"].tap()
        XCTAssertTrue(app.buttons["file.edit"].waitForExistence(timeout: 15))
        app.buttons["file.menu"].tap()
        app.buttons["View source"].tap()
        XCTAssertTrue((element(app, "preview.text").value as? String)?.contains("Edited on the phone.") == true)
        screenshot("saved")
    }

    func testSearchFindsAFileAndANewFileOpensAndCanBeDeletedAndRestored() throws {
        let app = launchIntoFiles()
        XCTAssertTrue(app.buttons["file.apps/"].waitForExistence(timeout: 15))
        app.swipeDown()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("retry")
        XCTAssertTrue(app.buttons["search.apps/web/src/relay/retry.ts"].waitForExistence(timeout: 15))
        screenshot("search")
        app.buttons["search.apps/web/src/relay/retry.ts"].tap()
        XCTAssertTrue(element(app, "preview.text").waitForExistence(timeout: 15))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons.matching(NSPredicate(format: "label IN %@", ["Cancel", "Close"])).firstMatch.tap()

        app.buttons["files.manage"].tap()
        app.buttons["files.newFile"].tap()
        let path = app.alerts.textFields.firstMatch
        XCTAssertTrue(path.waitForExistence(timeout: 5))
        let name = "notes-\(Int(Date().timeIntervalSince1970)).md"
        path.typeText(name)
        screenshot("new-file")
        app.alerts.buttons["Create"].firstMatch.tap()
        let created = app.staticTexts["Empty file"].waitForExistence(timeout: 15)
        screenshot("created")
        XCTAssertTrue(created)
        app.buttons["file.menu"].tap()
        app.buttons["Delete"].tap()
        XCTAssertTrue(app.alerts.buttons["Delete"].firstMatch.waitForExistence(timeout: 5))
        screenshot("delete-confirm")
        app.alerts.buttons["Delete"].firstMatch.tap()
        let undo = app.buttons["files.strip.action"]
        XCTAssertTrue(undo.waitForExistence(timeout: 15))
        screenshot("deleted")
        undo.tap()
        let restored = app.buttons["file.\(name)"]
        for _ in 0..<8 where !restored.waitForExistence(timeout: 2) { app.swipeUp() }
        XCTAssertTrue(restored.exists)
    }

    func testAnAnswersLinkOpensItsCheckoutFileAtTheLine() throws {
        let app = launchIntoThread()
        let link = app.links["outbox.ts"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        let text = element(app, "preview.text")
        XCTAssertTrue(text.waitForExistence(timeout: 15))
        screenshot("link-line")
    }

    private func launchIntoThread() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        let row = app.buttons["thread.ios-files"]
        for _ in 0..<12 where !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        return app
    }
    private func launchIntoFiles() -> XCUIApplication {
        let app = launchIntoThread()
        app.buttons["thread.menu"].tap()
        app.buttons["thread.files"].tap()
        return app
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-files-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("files-\(name).png"))
        }
    }
}
