import XCTest

/// A message's actions, the fork composer, rename, Turns, Attachments, Pi's Retry, Bring back and
/// rendered Markdown, against the spike fixture's `ios-turns`, `ios-pi`, `ios-fork` and
/// `ios-markdown`. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also
/// saves the screenshots. Run on a fresh fixture: forking adds threads to it.
@MainActor final class ThreadTransitionsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testForkFromAnAnswerOpensTheForkInTheComposer() {
        let app = launch()
        open("ios-turns", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.fork.", in: app))
        screenshot("message-actions")
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "message.fork.")).firstMatch
        app.bringToMiddle(first)
        first.tap()
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["composer.fork.cancel"].exists)
        screenshot("fork-composer")
        let input = app.textViews["composer.input"]
        input.typeText("Try a fake clock in one test first")
        screenshot("fork-composer-typed")
        app.buttons["composer.send"].tap()
        // The fork opens once the machine has started it.
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForNonExistence(timeout: 20))
        screenshot("fork-opened")
    }

    func testEditForksFromBeforeTheMessageWithItsWords() {
        let app = launch()
        open("ios-turns", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.edit.", in: app))
        let edit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "message.edit.")).element(boundBy: 0)
        app.bringToMiddle(edit)
        edit.tap()
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForExistence(timeout: 15))
        let input = app.textViews["composer.input"]
        XCTAssertTrue((input.value as? String)?.isEmpty == false, "the edited message's words start the fork")
        screenshot("edit-composer")
        app.buttons["composer.fork.cancel"].tap()
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForNonExistence(timeout: 10))
    }

    func testRenameTurnsAndAttachmentsFromTheHeader() {
        let app = launch()
        open("ios-turns", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.copy.", in: app))
        let title = app.buttons["thread.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        title.tap()
        XCTAssertTrue(app.buttons["Rename…"].waitForExistence(timeout: 10))
        screenshot("title-menu")
        app.buttons["Rename…"].tap()
        let field = app.textFields["rename.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        screenshot("rename-sheet")
        // The whole name is selected: typing replaces it.
        field.typeText("Fake the queue clock")
        app.buttons["rename.save"].tap()
        sleep(2)
        screenshot("renamed")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == 'thread.title' AND label CONTAINS 'Fake the queue clock'")).firstMatch.waitForExistence(timeout: 15))
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Turns"].waitForExistence(timeout: 10))
        screenshot("thread-menu")
        app.buttons["Turns"].tap()
        XCTAssertTrue(app.buttons["turn.1"].waitForExistence(timeout: 15))
        screenshot("turns-sheet")
        app.buttons["turn.1"].tap()
        XCTAssertTrue(app.buttons["turn.1"].waitForNonExistence(timeout: 10))
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Attachments"].waitForExistence(timeout: 10))
        app.buttons["Attachments"].tap()
        XCTAssertTrue(app.navigationBars["Attachments"].waitForExistence(timeout: 15))
        screenshot("attachments-sheet")
    }

    func testPiOffersRetryAndRewind() {
        let app = launch()
        open("ios-pi", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.retry.", in: app))
        XCTAssertTrue(waitForAny(prefix: "message.rewind.", in: app))
        screenshot("pi-retry-rewind")
        let rewind = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "message.rewind.")).firstMatch
        app.bringToMiddle(rewind)
        rewind.tap()
        XCTAssertTrue(app.buttons["rewind.confirm"].waitForExistence(timeout: 10))
        screenshot("rewind-confirm")
    }

    func testBringBackFromAFork() {
        let app = launch()
        open("ios-fork", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.copy.", in: app))
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Bring back to parent…"].waitForExistence(timeout: 15))
        screenshot("fork-menu")
        app.buttons["Bring back to parent…"].tap()
        XCTAssertTrue(app.textViews["merge.summary"].waitForExistence(timeout: 15))
        screenshot("bring-back")
    }

    func testMarkdownMathCodeAndDiff() {
        let app = launch()
        open("ios-markdown", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.copy.", in: app))
        sleep(2)
        screenshot("markdown-math-code-diff")
    }

    private func waitForAny(prefix: String, in app: XCUIApplication, timeout: TimeInterval = 90) -> Bool {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch.waitForExistence(timeout: timeout)
    }
    private func open(_ id: String, in app: XCUIApplication) {
        app.terminate()
        app.launchArguments += ["--spike-open", id]
        app.launch()
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}

private extension XCUIElement {
    func clearAndType(_ text: String) {
        // The caret at the end, so every character before it can be deleted.
        coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        if let value = value as? String, !value.isEmpty {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 4))
        }
        typeText(text)
    }
}
