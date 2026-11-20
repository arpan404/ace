import XCTest

/// Commenting and reviewing a pull request on the spike fixture (`bun run spike:daemon`, which
/// seeds the fake GitHub): #245 in acme/ace has a comment with reactions, a review and a line
/// conversation. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves
/// each screenshot there.
@MainActor final class ForgeReviewUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testCommentFromTheTimelineJoinsIt() {
        let app = openPull()
        let timeline = app.buttons["forge.pull.timeline"]
        app.reveal(timeline)
        timeline.tap()
        XCTAssertTrue(element(app, "forge.comment.issue:2451").waitForExistence(timeout: 20))
        XCTAssertTrue(element(app, "forge.thread.RT_2454").exists)
        screenshot("timeline")
        let box = app.textFields["forge.editor"].firstMatch
        box.tap()
        box.typeText("Checked on the phone.")
        app.buttons["forge.timeline.comment"].tap()
        XCTAssertTrue(app.staticTexts["Checked on the phone."].waitForExistence(timeout: 20))
        screenshot("timeline-commented")
        app.buttons["forge.review.open"].tap()
        XCTAssertTrue(app.buttons["forge.review.submit"].waitForExistence(timeout: 10))
        screenshot("review-sheet")
    }

    func testLineConversationAndNewLineCommentInTheCodeView() {
        let app = openPull()
        let files = app.buttons["forge.pull.files"]
        app.reveal(files)
        files.tap()
        let file = app.buttons["forge.files.0"]
        XCTAssertTrue(file.waitForExistence(timeout: 20))
        app.reveal(file)
        file.tap()
        let conversation = element(app, "forge.thread.RT_2454")
        if !conversation.waitForExistence(timeout: 40) { screenshot("code-missing") }
        XCTAssertTrue(conversation.exists)
        screenshot("code")
        app.buttons["forge.line.RIGHT.6"].tap()
        // A tap picks the line; Comment opens the comment on it.
        XCTAssertTrue(app.buttons["forge.pick.comment"].waitForExistence(timeout: 10))
        app.buttons["forge.pick.comment"].tap()
        XCTAssertTrue(app.buttons["forge.write.suggest"].waitForExistence(timeout: 10))
        app.buttons["forge.write.suggest"].tap()
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Keep editing"].waitForExistence(timeout: 5))
        app.buttons["Keep editing"].tap()
        XCTAssertTrue((app.textFields["forge.editor"].firstMatch.value as? String)?.contains("suggestion") == true)
        screenshot("line-comment")
        let threads = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'forge.thread.RT_'"))
        let before = threads.count
        app.buttons["forge.write.secondary"].tap()
        // The single comment opens a new conversation under its line once GitHub is read again.
        let more = expectation(for: NSPredicate(format: "count > \(before)"), evaluatedWith: threads)
        wait(for: [more], timeout: 20)
        screenshot("code-commented")
    }

    func testMentionCompletesInTheCommentBox() {
        let app = openPull()
        let timeline = app.buttons["forge.pull.timeline"]
        app.reveal(timeline)
        timeline.tap()
        let box = app.textFields["forge.editor"].firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 20))
        box.tap()
        box.typeText("Thanks @mi")
        let suggestion = app.buttons["forge.suggestion.@mira"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 15))
        screenshot("mention")
        suggestion.tap()
        XCTAssertEqual(box.value as? String, "Thanks @mira ")
    }

    func testRequestingAReviewerAddsThemAwaitingReview() {
        let app = openPull()
        let request = app.buttons["forge.reviewers.request"]
        app.reveal(request)
        screenshot("reviewers")
        request.tap()
        let jonas = app.buttons["forge.request.jonas"]
        XCTAssertTrue(jonas.waitForExistence(timeout: 15))
        screenshot("request-review")
        jonas.tap()
        XCTAssertTrue(element(app, "forge.reviewer.jonas").waitForExistence(timeout: 20))
    }

    func testRichTextDrawsAndABoxInYourOwnCommentTicks() {
        let app = openPull()
        // The description's uploads, alerts and diagram arrive through the daemon.
        for _ in 0..<2 { app.swipeUp() }
        screenshot("rich-description")
        for _ in 0..<2 { app.swipeUp() }
        screenshot("rich-description-more")
        let timeline = app.buttons["forge.pull.timeline"]
        app.reveal(timeline)
        timeline.tap()
        let comment = element(app, "forge.comment.issue:2452")
        XCTAssertTrue(comment.waitForExistence(timeout: 20))
        // markit draws a box as a glyph in the text, a link where the box ticks.
        let open = comment.links.matching(NSPredicate(format: "label BEGINSWITH '☐'")).firstMatch
        if !open.waitForExistence(timeout: 10) { screenshot("task-missing") }
        XCTAssertTrue(open.exists, "The box in your own comment ticks")
        app.lower(open)
        let done = comment.links.matching(NSPredicate(format: "label BEGINSWITH '☑'"))
        let before = done.count
        open.tap()
        let ticked = expectation(for: NSPredicate(format: "count > \(before)"), evaluatedWith: done)
        if XCTWaiter().wait(for: [ticked], timeout: 20) != .completed { screenshot("task-unticked") }
        XCTAssertGreaterThan(done.count, before)
        screenshot("task-ticked")
    }

    /// #245's settings guide carries two of mira's suggestions on the current diff and one on
    /// the save bar that a push outdated. Commit opens GitHub's message; a batch commits both at
    /// once, after which their lines changed and only the agent is offered.
    func testSuggestionsCommitOneByOneOrAsABatch() {
        let app = openPull()
        let timeline = app.buttons["forge.pull.timeline"]
        app.reveal(timeline)
        timeline.tap()
        let commit = app.buttons["forge.suggestion.commit.2456"]
        XCTAssertTrue(commit.waitForExistence(timeout: 20))
        app.reveal(commit)
        // Pushed over since: GitHub can't commit it, so only the agent is offered.
        XCTAssertFalse(app.buttons["forge.suggestion.commit.2458"].exists)
        XCTAssertTrue(app.buttons["forge.suggestion.agent.2458"].exists)
        screenshot("suggestions")
        commit.tap()
        let message = app.textFields["forge.editor"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.value as? String, "Apply suggestion from @mira")
        screenshot("suggestion-commit")
        app.buttons["Cancel"].tap()
        app.buttons["forge.suggestion.batch.2456"].tap()
        let second = app.buttons["forge.suggestion.batch.2457"]
        app.reveal(second)
        second.tap()
        let batch = app.buttons["forge.batch.commit"]
        XCTAssertTrue(batch.waitForExistence(timeout: 5))
        XCTAssertEqual(batch.label, "Commit 2 suggestions")
        XCTAssertEqual(app.buttons["forge.suggestion.batch.2456"].label, "Remove from batch")
        screenshot("suggestion-batch")
        batch.tap()
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.value as? String, "Apply suggestions from code review")
        app.buttons["forge.write.primary"].tap()
        // One commit took both: the batch empties and their lines are no longer on the diff.
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["forge.suggestion.commit.2456"])
        wait(for: [gone], timeout: 20)
        XCTAssertFalse(app.buttons["forge.batch.commit"].exists)
        XCTAssertTrue(app.buttons["forge.suggestion.agent.2457"].exists)
        screenshot("suggestion-committed")
    }

    private func openPull() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 25))
        app.openPulls()
        let row = app.buttons["forge.pull.245"]
        XCTAssertTrue(row.waitForExistence(timeout: 25))
        row.tap()
        XCTAssertTrue(element(app, "forge.pull.header").waitForExistence(timeout: 20))
        screenshot("pull")
        return app
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-forge-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("forge-\(name).png"))
        }
    }
}
