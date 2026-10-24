import XCTest

/// Plan review and form cards, the effort and speed chip, the attach menu, a finished turn's full
/// steps and going back from a child, against the spike fixture, with screenshots. Run on a fresh
/// fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ThreadGapsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testPlanReviewAndTuneChip() {
        let app = launch()
        open("ios-plan", in: app)
        XCTAssertTrue(app.buttons["plan.approve"].waitForExistence(timeout: 25))
        screenshot("plan-review")
        app.buttons["plan.revise"].tap()
        let feedback = app.textFields["plan.feedback"]
        XCTAssertTrue(feedback.waitForExistence(timeout: 10))
        feedback.tap()
        feedback.typeText("Also cover zombie processes")
        screenshot("plan-revise")
        // The model chip's effort part opens effort and speed, the levels in words.
        XCTAssertTrue(app.buttons["composer.effort"].waitForExistence(timeout: 25))
        app.buttons["composer.effort"].tap()
        let high = app.buttons["composer.tune.high"]
        XCTAssertTrue(high.waitForExistence(timeout: 25))
        high.tap()
        XCTAssertTrue(app.buttons["composer.tune.high"].waitForExistence(timeout: 10))
        let selected = NSPredicate(format: "isSelected == true")
        expectation(for: selected, evaluatedWith: app.buttons["composer.tune.high"])
        waitForExpectations(timeout: 10)
        screenshot("tune-effort")
        app.otherElements["tunePanel"].swipeDown(velocity: .fast)
        XCTAssertTrue(app.buttons["composer.tune.high"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["composer.attach"].waitForExistence(timeout: 10))
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 10))
        screenshot("attach-menu")
    }
    func testFormCard() {
        let app = launch()
        open("ios-form", in: app)
        XCTAssertTrue(app.buttons["form.submit"].waitForExistence(timeout: 25))
        screenshot("form-request")
    }
    func testFullStepsAndBackFromChild() {
        let app = launch()
        open("ios-agents", in: app)
        let worked = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(worked.waitForExistence(timeout: 25))
        app.scrollViews["transcript"].swipeDown(velocity: .fast)
        worked.tap()
        // The turn's steps open grouped, as on the web: sentence rows on a rail.
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "work.group.")).firstMatch.waitForExistence(timeout: 15))
        screenshot("worked-full-steps")
        app.buttons["subagents.rollup"].firstMatch.tap()
        let review = app.buttons["subagent.Review PID-reuse safety"]
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()
        XCTAssertTrue(app.staticTexts["Review the kill-all change for PID-reuse safety."].waitForExistence(timeout: 25))
        app.navigationBars.buttons.firstMatch.tap()
        // The parent's transcript is on screen at once, never the empty loading state.
        XCTAssertFalse(app.staticTexts["Loading conversation…"].exists)
        screenshot("back-from-child")
        let explore = app.buttons["subagent.Explore process groups"]
        XCTAssertTrue(explore.waitForExistence(timeout: 25))
        explore.tap()
        XCTAssertTrue(app.collectionViews["lane.transcript"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Process groups are created per thread."].waitForExistence(timeout: 10))
        screenshot("agent-lane-grouped")
    }
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons["thread.\(id)"]
        if !row.waitForExistence(timeout: 25) { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
