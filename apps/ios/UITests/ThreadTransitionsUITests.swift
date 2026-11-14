import XCTest

/// A message's actions, the fork composer, rename, Turns, Attachments, Pi's Retry, Bring back,
/// rendered Markdown, the person's markdown bubble and a brief another thread sent, against the
/// spike fixture's `ios-turns`, `ios-pi`, `ios-fork`, `ios-markdown`, `ios-messages` and `ios-sent`. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also
/// saves the screenshots. Run on a fresh fixture: forking adds threads to it.
@MainActor final class ThreadTransitionsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testForkFromAnAnswerOpensTheForkInTheComposer() {
        let app = launch()
        open("ios-turns", in: app)
        // A message's actions are in its long-press menu: nothing sits under it at rest.
        XCTAssertTrue(waitForAny(prefix: "message.answer.", in: app))
        openMenu(of: message("message.answer.", in: app), in: app)
        screenshot("message-actions")
        app.buttons["Fork from here"].tap()
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

    func testEditForksFromBeforeTheMessageWithItsWordsAndImage() {
        let app = launch()
        open("ios-turns", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.user.", in: app))
        // The first message that can be edited carries a picture.
        openMenu(of: message("message.user.", in: app), in: app)
        app.buttons["Edit"].tap()
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForExistence(timeout: 15))
        let input = app.textViews["composer.input"]
        XCTAssertTrue((input.value as? String)?.isEmpty == false, "the edited message's words start the fork")
        // Its picture is on the fork's message, the same stored file, and can be taken off.
        XCTAssertTrue(app.buttons["composer.media"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["composer.media.remove"].exists)
        screenshot("edit-composer")
        input.typeText(" with one fake clock")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(app.staticTexts["composer.fork"].waitForNonExistence(timeout: 20))
        // The fork opens with the picture on its first message.
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "attachment.image.")).firstMatch.waitForExistence(timeout: 30))
        screenshot("edit-fork-opened")
    }

    func testRenameTurnsAndAttachmentsFromTheHeader() {
        let app = launch()
        open("ios-turns", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.", in: app))
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
        XCTAssertTrue(app.buttons["file.open.timings.txt"].waitForExistence(timeout: 15))
        screenshot("attachments-sheet")
        // A picture opens full screen, with Share.
        app.buttons["file.open.queue-timings.png"].tap()
        XCTAssertTrue(app.buttons["media.share"].waitForExistence(timeout: 15))
        screenshot("attachment-image")
        app.buttons["media.close"].tap()
        // A document opens in Quick Look, which shares it too.
        app.buttons["file.open.timings.txt"].tap()
        XCTAssertTrue(app.navigationBars["timings.txt"].waitForExistence(timeout: 20) || app.otherElements["QLPreviewControllerView"].waitForExistence(timeout: 5))
        screenshot("attachment-document")
    }

    func testPiOffersRetryAndRewind() {
        let app = launch()
        open("ios-pi", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.answer.", in: app))
        // Retry sits under the last answer, Rewind under an earlier one, both in the long-press menu.
        let answers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "message.answer."))
        openMenu(of: answers.element(boundBy: answers.count - 1), in: app)
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 10))
        screenshot("pi-retry-rewind")
        app.tap()
        openMenu(of: answers.element(boundBy: 0), in: app)
        app.buttons["Rewind to here"].tap()
        XCTAssertTrue(app.buttons["rewind.confirm"].waitForExistence(timeout: 10))
        screenshot("rewind-confirm")
    }

    func testBringBackFromAFork() {
        let app = launch()
        open("ios-fork", in: app)
        XCTAssertTrue(waitForAny(prefix: "message.", in: app))
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
        XCTAssertTrue(waitForAny(prefix: "message.", in: app))
        // markit draws the answer natively: its fenced code as a block with its own Copy, its math
        // typeset as images in the text (no web view), from the first frame of a finished answer.
        XCTAssertTrue(app.buttons["Copy code"].firstMatch.waitForExistence(timeout: 20))
        // A paragraph holding typeset math reads its formulas as their source (markit speaks an
        // attachment by its TeX), and it only does so once the formula is drawn as an image.
        let typeset = app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@", "\\sigma^2")).firstMatch
        XCTAssertTrue(typeset.waitForExistence(timeout: 20), "The inline formula is typeset")
        let display = app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@", "mc^2")).firstMatch
        XCTAssertTrue(display.waitForExistence(timeout: 20), "The display formula is typeset")
        XCTAssertEqual(app.webViews.count, 0)
        sleep(1)
        screenshot("markdown-math-code-diff")
    }

    func testSentByLineOpensTheThreadThatSentTheBrief() {
        let app = launch()
        open("ios-sent", in: app)
        let line = app.buttons["message.sentBy"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 90))
        app.bringToMiddle(line)
        // The sender reads by its title in the thread list.
        XCTAssertEqual(line.label, "Sent by Keep the retry budget across restarts")
        // The brief shows its first four lines until it is opened.
        let fold = message("message.fold.", in: app)
        XCTAssertTrue(fold.waitForExistence(timeout: 10))
        XCTAssertEqual(fold.value as? String, "Collapsed")
        screenshot("sent-by")
        line.tap()
        let sender = app.buttons.matching(NSPredicate(format: "identifier == 'thread.title' AND label CONTAINS 'Keep the retry budget'")).firstMatch
        XCTAssertTrue(sender.waitForExistence(timeout: 20), "the sender's thread opens")
        screenshot("sent-by-opened")
    }

    func testTheMarkdownBubbleFoldsAndOpensWithShowMore() {
        let app = launch()
        open("ios-messages", in: app)
        // The long ask is a list with code: rendered as markdown, folded under Show more.
        let fold = message("message.fold.", in: app)
        XCTAssertTrue(fold.waitForExistence(timeout: 90))
        app.bringToMiddle(fold)
        XCTAssertEqual(fold.value as? String, "Collapsed")
        screenshot("markdown-bubble-folded")
        fold.tap()
        XCTAssertEqual(fold.value as? String, "Expanded")
        screenshot("markdown-bubble-open")
    }

    private func waitForAny(prefix: String, in app: XCUIApplication, timeout: TimeInterval = 90) -> Bool {
        message(prefix, in: app).waitForExistence(timeout: timeout)
    }
    private func message(_ prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }
    /// A message's long-press menu: Copy, Select text, Share and what can be done from it.
    private func openMenu(of message: XCUIElement, in app: XCUIApplication) {
        app.bringToMiddle(message)
        message.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 10))
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

extension XCUIElement {
    /// Replaces a text field's text (shared by the UI tests that edit a name).
    func clearAndType(_ text: String) {
        // The caret at the end, so every character before it can be deleted.
        coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        if let value = value as? String, !value.isEmpty {
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 4))
        }
        typeText(text)
    }
}
