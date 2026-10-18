import XCTest

/// Settings, the archive, the offline snooze end and the accessibility audit against the spike
/// fixture (`scripts/archive-scenario.ts`). `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port;
/// `TEST_RUNNER_ACE_IOS_TEXT_SIZE` (a UIContentSizeCategory name) runs them at another text size.
@MainActor final class PolishUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    func testSettingsHoldPerMachineNotificationsLicencesAndDiagnostics() throws {
        let app = launch()
        app.buttons["inbox.settings"].tap()
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["settings.diagnostics"].exists)
        screenshot("settings")
        app.buttons["settings.notifications"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["notifications.enabled"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'notifications.machine.'")).firstMatch.exists)
        screenshot("settings-notifications")
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(app.buttons["settings.licences"].waitForExistence(timeout: 5))
        app.buttons["settings.licences"].tap()
        XCTAssertTrue(app.staticTexts["Zod"].waitForExistence(timeout: 5))
        screenshot("settings-licences")
    }

    func testArchivePagesOlderThreadsAndOpensOneReadOnly() throws {
        let app = launch()
        app.buttons["inbox.settings"].tap()
        XCTAssertTrue(app.buttons["settings.archive"].waitForExistence(timeout: 10))
        app.buttons["settings.archive"].tap()
        // Most recently archived first, twenty to a page.
        XCTAssertTrue(app.buttons["archive.ios-archived-44"].waitForExistence(timeout: 15))
        screenshot("archive")
        let older = app.buttons["archive.ios-archived-10"]
        for _ in 0..<12 where !older.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(older.waitForExistence(timeout: 10))
        older.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.archived"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["composer.send"].exists)
        screenshot("archive-thread")
    }

    /// The fixture snoozed `ios-nap` for `ACE_IOS_SPIKE_NAP_MS`. The fixture goes offline before
    /// that, so only the phone's clock can end it.
    func testASnoozeEndsOnThePhoneWhileTheMachineIsOffline() throws {
        let app = launch()
        let settled = app.buttons["inbox.settled"].firstMatch
        for _ in 0..<6 where !settled.exists { app.swipeUp() }
        settled.tap()
        let nap = app.buttons["thread.ios-nap"]
        XCTAssertTrue(nap.waitForExistence(timeout: 10))
        XCTAssertTrue(nap.label.contains("Until"), nap.label)
        try control(online: false)
        defer { try? control(online: true) }
        XCTAssertTrue(app.descendants(matching: .any)["inbox.connection"].waitForExistence(timeout: 30))
        let ended = expectation(for: NSPredicate(format: "label CONTAINS 'Snooze ended'"), evaluatedWith: nap)
        wait(for: [ended], timeout: 200)
        screenshot("snooze-ended-offline")
    }

    func testEveryScreenPassesTheAccessibilityAudit() throws {
        continueAfterFailure = true // Audit every screen, then report them all.
        let app = launch()
        try audit(app, "inbox")
        app.buttons["thread.ios-tree"].tap()
        XCTAssertTrue(app.buttons["thread.agents"].waitForExistence(timeout: 15))
        try audit(app, "thread")
        app.buttons["thread.agents"].tap()
        XCTAssertTrue(app.buttons["agents.stopAll"].waitForExistence(timeout: 15))
        // Audit the expanded sheet: at the medium detent rows run under the screen edge.
        app.swipeUp()
        try audit(app, "agents")
        app.swipeDown(velocity: .fast)
        app.buttons["thread.changes"].tap()
        XCTAssertTrue(app.buttons["changes.step"].waitForExistence(timeout: 15))
        app.swipeUp()
        try audit(app, "changes")
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        app.buttons["BackButton"].firstMatch.tap()
        app.buttons["inbox.machines"].tap()
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10))
        try audit(app, "machines")
        app.buttons["Done"].tap()
        app.buttons["inbox.settings"].tap()
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10))
        try audit(app, "settings")
    }

    // MARK: Helpers

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        if let size = ProcessInfo.processInfo.environment["ACE_IOS_TEXT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-tree"].waitForExistence(timeout: 25))
        return app
    }
    /// Every audit issue is listed in an attachment. Missing descriptions, small hit areas and
    /// failed contrast fail the test. Reported only: `.dynamicType` (the token fonts scale through
    /// `@ScaledMetric` into `.system(size:)`, which the audit can't see; the AX-size screenshots
    /// check scaling), "nearly passed" contrast on system section headers, and titles the
    /// navigation bar truncates (VoiceOver reads them whole).
    private func audit(_ app: XCUIApplication, _ name: String) throws {
        screenshot("audit-\(name)")
        var found: [String] = []
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            let line = "\(issue.auditType) \(element?.identifier ?? "-") '\(element?.label ?? "")': \(issue.compactDescription)"
            let blocking: XCUIAccessibilityAuditType = [.sufficientElementDescription, .hitRegion, .contrast]
            let exempt = !blocking.contains(issue.auditType) || element == nil || element?.elementType == .navigationBar
                || issue.compactDescription.contains("nearly")
            found.append((exempt ? "exempt " : "ISSUE ") + line)
            return true
        }
        let report = XCTAttachment(string: found.joined(separator: "\n"))
        report.name = "audit-\(name).txt"
        report.lifetime = .keepAlways
        add(report)
        XCTAssertEqual(found.filter { $0.hasPrefix("ISSUE") }, [], "Accessibility audit: \(name)")
    }
    private func control(online: Bool) throws {
        guard let url = URL(string: "http://127.0.0.1:\(port)/control") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"online":\#(online)}"#.utf8)
        let done = expectation(description: "control")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
