import XCTest

/// The Agents and Changes sheets against the spike fixture's `ios-tree` thread
/// (`scripts/sheet-scenario.ts`). Pass `ACE_IOS_SPIKE_PORT` through to use another fixture port.
@MainActor final class SheetsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testAgentsSheetShowsTheTreeAndAsksBeforeStoppingIt() throws {
        let app = launchIntoTree()
        app.buttons["thread.agents"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Reviewer")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Running in background"].waitForExistence(timeout: 10))
        screenshot("agents-medium")
        app.swipeUp()
        screenshot("agents-large")
        app.buttons["agents.stopAll"].tap()
        XCTAssertTrue(app.buttons["agents.confirmStop"].waitForExistence(timeout: 5))
        screenshot("agents-stop-confirm")
        app.buttons["Cancel"].firstMatch.tap()
    }

    func testChangesSheetShowsFilesADiffAndTheNextStep() throws {
        let app = launchIntoTree()
        app.buttons["thread.changes"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes.totals"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["changes.step"].waitForExistence(timeout: 10))
        screenshot("changes")
        app.buttons["changes.file.packages/provider-kit/src/process-owner.ts"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["diff.view"].waitForExistence(timeout: 10))
        screenshot("changes-diff")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["changes.file.apps/daemon/src/cli/kill-all.fixtures.ts"].tap()
        let truncated = app.descendants(matching: .any)["diff.truncated"]
        for _ in 0..<40 where !truncated.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(truncated.exists)
        screenshot("changes-diff-truncated")
    }

    private func launchIntoTree() -> XCUIApplication {
        let app = XCUIApplication()
        let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-tree"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-tree"].tap()
        XCTAssertTrue(app.buttons["thread.agents"].waitForExistence(timeout: 15))
        return app
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
