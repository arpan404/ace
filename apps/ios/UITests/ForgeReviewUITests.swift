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
        for _ in 0..<6 where !timeline.isHittable { app.swipeUp() }
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
        for _ in 0..<6 where !files.isHittable { app.swipeUp() }
        files.tap()
        let file = app.buttons["forge.files.0"]
        XCTAssertTrue(file.waitForExistence(timeout: 20))
        for _ in 0..<6 where !file.isHittable { app.swipeUp() }
        file.tap()
        XCTAssertTrue(element(app, "forge.thread.RT_2454").waitForExistence(timeout: 20))
        screenshot("code")
        app.buttons["forge.line.RIGHT.6"].tap()
        XCTAssertTrue(app.buttons["forge.write.suggest"].waitForExistence(timeout: 10))
        app.buttons["forge.write.suggest"].tap()
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
        for _ in 0..<6 where !timeline.isHittable { app.swipeUp() }
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
        for _ in 0..<6 where !request.isHittable { app.swipeUp() }
        screenshot("reviewers")
        request.tap()
        let jonas = app.buttons["forge.request.jonas"]
        XCTAssertTrue(jonas.waitForExistence(timeout: 15))
        screenshot("request-review")
        jonas.tap()
        XCTAssertTrue(element(app, "forge.reviewer.jonas").waitForExistence(timeout: 20))
    }

    private func openPull() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        app.tabBars.buttons["Pulls"].firstMatch.tap()
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
