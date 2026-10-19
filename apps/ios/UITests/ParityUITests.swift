import XCTest

@MainActor final class ParityUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testBottomTaskEntryOpensTheNativeDraft() {
        let app = launch()
        let start = app.buttons["inbox.startTask"]
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        start.tap()
        XCTAssertTrue(app.navigationBars["New thread"].waitForExistence(timeout: 10))
        capture("start-task")
    }

    func testCanonicalApprovalLabelsAndKeyboardKeepComposerVisible() {
        let app = launch()
        let row = app.buttons["thread.ios-approval"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.buttons["approval.allow_once"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.buttons["approval.allow_once"].label, "Allow once")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Always allow")).firstMatch.exists)
        let input = app.textViews["composer.input"]
        input.tap()
        input.typeText((1...12).map { "Line \($0)" }.joined(separator: "\n"))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertTrue(app.buttons["composer.send"].isHittable)
        capture("approval-keyboard")
    }

    func testDarkInboxAndThread() {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.startTask"].waitForExistence(timeout: 30))
        capture("inbox")
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_once"].waitForExistence(timeout: 30))
        capture("approval")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "parity-\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
