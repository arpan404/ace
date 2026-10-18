import XCTest

/// The thread screen against the spike fixture's thread scenarios, with screenshots. Run on a
/// fresh fixture; `TEST_RUNNER_ACE_SPIKE_PORT` selects its port.
@MainActor final class ThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testWorkedTurnSubagentsChildThreadAndModelPicker() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-agents"].waitForExistence(timeout: 25))
        screenshot("thread-inbox")
        app.buttons["thread.ios-agents"].tap()
        let worked = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(worked.waitForExistence(timeout: 25))
        swipeToTop(app)
        screenshot("thread-transcript")
        worked.tap()
        screenshot("thread-worked-expanded")
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
        app.buttons["Done"].tap()
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Stop all agents"].waitForExistence(timeout: 10))
        screenshot("thread-menu")
    }
    func testQuestionAndApprovalCards() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-question"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-question"].tap()
        XCTAssertTrue(app.buttons["question.answer"].waitForExistence(timeout: 25))
        app.buttons["question.archive.skip"].tap()
        screenshot("thread-question")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_session"].waitForExistence(timeout: 25))
        screenshot("thread-approval")
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func swipeToTop(_ app: XCUIApplication) {
        let transcript = app.collectionViews["transcript"]
        if transcript.exists { transcript.swipeDown(velocity: .fast) }
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
