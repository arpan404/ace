import XCTest

/// The thread screen against the spike fixture's thread scenarios, with screenshots. Run on a
/// fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testWorkedTurnSubagentsChildThreadAndModelPicker() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        screenshot("thread-inbox")
        app.buttons["thread.ios-agents"].tap()
        let worked = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(worked.waitForExistence(timeout: 25))
        swipeToTop(app)
        screenshot("thread-transcript")
        worked.tap()
        screenshot("thread-worked-expanded")
        app.buttons["subagents.rollup"].firstMatch.tap()
        let review = app.buttons["subagent.Review PID-reuse safety"]
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()
        XCTAssertTrue(app.staticTexts["Review the kill-all change for PID-reuse safety."].waitForExistence(timeout: 25))
        screenshot("thread-child")
        app.navigationBars.buttons.firstMatch.tap()
        let tests = app.buttons["subagent.Write orphan-cleanup tests"]
        XCTAssertTrue(tests.waitForExistence(timeout: 25))
        tests.tap()
        XCTAssertTrue(app.staticTexts["Writing the PID-reuse regression."].waitForExistence(timeout: 10))
        screenshot("thread-agent-lane")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["composer.model"].waitForExistence(timeout: 10))
        app.buttons["composer.model"].tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 10))
        sleep(2)
        screenshot("thread-models")
        app.closeSheet()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Then update the docs")
        app.buttons["composer.send"].tap()
        // A queued message takes the strip above the composer; one that went in now is in the transcript.
        XCTAssertTrue(app.descendants(matching: .any)["queue.strip"].waitForExistence(timeout: 15) || app.staticTexts["Then update the docs"].waitForExistence(timeout: 5))
        screenshot("thread-queue")
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Stop all agents"].waitForExistence(timeout: 10))
        screenshot("thread-menu")
    }
    func testQuestionAndApprovalCards() {
        let app = launch()
        reveal("thread.ios-question", in: app)
        app.buttons["thread.ios-question"].tap()
        XCTAssertTrue(app.buttons["question.answer"].waitForExistence(timeout: 25))
        // The question sits on the strip with the composer still under it, as on the web; the
        // transcript says who asks it.
        XCTAssertTrue(app.textViews["composer.input"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["transcript.question"].waitForExistence(timeout: 10))
        app.buttons["question.archive.skip"].tap()
        screenshot("thread-question")
        app.navigationBars.buttons.firstMatch.tap()
        reveal("thread.ios-approval", in: app)
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_session"].waitForExistence(timeout: 25))
        screenshot("thread-approval")
    }
    /// Leaving a scrolled transcript with a "Worked for" log open tears its views down after the
    /// thread's session closed; their releases must not surface as a failed request in the inbox.
    func testBackFromScrolledThreadShowsNoRequestAlert() {
        let app = launch()
        for round in 0..<3 {
            reveal("thread.ios-agents", in: app)
            app.buttons["thread.ios-agents"].tap()
            let worked = app.buttons["work.toggle"].firstMatch
            XCTAssertTrue(worked.waitForExistence(timeout: 25))
            let transcript = app.scrollViews["transcript"]
            transcript.swipeDown(velocity: .fast)
            if round == 0, worked.isHittable { worked.tap() }
            transcript.swipeUp(velocity: .fast)
            transcript.swipeDown(velocity: .fast)
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.buttons["thread.ios-agents"].waitForExistence(timeout: 10))
            let alert = app.alerts["Request needs attention"]
            if alert.waitForExistence(timeout: 3) {
                screenshot("back-request-alert")
                XCTFail("Back from a scrolled thread raised: \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
                return
            }
        }
    }
    /// The inbox lists more fixture threads than fit; scroll until the row shows.
    private func reveal(_ identifier: String, in app: XCUIApplication) {
        let row = app.buttons[identifier]
        _ = row.waitForExistence(timeout: 25)
        for _ in 0..<4 where !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func swipeToTop(_ app: XCUIApplication) {
        let transcript = app.scrollViews["transcript"]
        if transcript.exists { transcript.swipeDown(velocity: .fast) }
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
