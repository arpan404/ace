import XCTest

/// Opt-in: pairs this simulator with a real daemon through the app's own pairing screen, so launch
/// and inbox timing can be measured on real saved data. `TEST_RUNNER_ACE_PAIR_LINK` carries the
/// read-only link from `ace pair`; `TEST_RUNNER_ACE_PAIR_THREAD` optionally selects a thread.
/// Checks transcript readiness and scene updates without sending messages or starting agents.
@MainActor final class RealDaemonPairUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPairsWithTheLinkAndOpensAResponsiveThread() throws {
        let link = try XCTUnwrap(ProcessInfo.processInfo.environment["ACE_PAIR_LINK"].flatMap { $0.isEmpty ? nil : $0 },
                                 "Set TEST_RUNNER_ACE_PAIR_LINK to a link from `ace pair`")
        let app = XCUIApplication()
        app.launchArguments += ["-ace-host-trace"]
        app.launch()
        // With nothing paired the inbox opens on Add device.
        let add = app.buttons["inbox.empty.pair"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let field = app.textFields["pairing.link"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText(link)
        app.buttons["pairing.continue"].tap()
        let name = app.textFields["pairing.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 20))
        app.buttons["pairing.confirm"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
            .waitForExistence(timeout: 60))
        let alerts = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts
        if alerts.firstMatch.waitForExistence(timeout: 3) {
            let deny = alerts.buttons["Don’t Allow"]
            if deny.exists { deny.tap() }
        }
        let target = ProcessInfo.processInfo.environment["ACE_PAIR_THREAD"]
        let first = target.map { app.buttons["thread." + $0] }
            ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
        for _ in 0..<12 where !first.exists { app.swipeUp() }
        XCTAssertTrue(first.waitForExistence(timeout: 20))
        first.tap()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 20))
        expectation(for: NSPredicate(format: "value == 'Ready'"), evaluatedWith: transcript)
        waitForExpectations(timeout: 30)
        XCTAssertFalse(app.descendants(matching: .any)["transcript.loading"].exists)
        // Background/foreground forces a scene update, the operation killed by the watchdog.
        XCUIDevice.shared.press(.home)
        app.activate()
        let sidebar = app.buttons["thread.sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))
    }
}
