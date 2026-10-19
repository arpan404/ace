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
        for _ in 0..<6 where !nap.exists { app.swipeUp() }
        XCTAssertTrue(nap.waitForExistence(timeout: 10))
        XCTAssertTrue(nap.label.contains("Until"), nap.label)
        try control(online: false)
        defer { try? control(online: true) }
        let ended = expectation(for: NSPredicate(format: "label CONTAINS 'Snooze ended'"), evaluatedWith: nap)
        wait(for: [ended], timeout: 200)
        screenshot("snooze-ended-offline")
    }

    func testEveryScreenPassesTheAccessibilityAudit() throws {
        continueAfterFailure = true // Audit every screen, then report them all.
        let app = launch()
        try audit(app, "inbox")
        open("ios-plan", in: app)
        XCTAssertTrue(app.buttons["plan.approve"].waitForExistence(timeout: 25))
        try audit(app, "plan-card")
        back(app)
        open("ios-form", in: app)
        XCTAssertTrue(app.buttons["form.submit"].waitForExistence(timeout: 25))
        try audit(app, "form-card")
        back(app)
        open("ios-agents", in: app)
        let worked = app.buttons["work.toggle"].firstMatch
        if worked.waitForExistence(timeout: 25) {
            worked.tap()
            _ = app.staticTexts["Ran"].waitForExistence(timeout: 15)
            try audit(app, "steps")
        }
        back(app)
        open("ios-tree", in: app)
        XCTAssertTrue(app.buttons["thread.agents"].waitForExistence(timeout: 15))
        try audit(app, "thread")
        app.buttons["thread.agents"].tap()
        XCTAssertTrue(app.buttons["agents.stopAll"].waitForExistence(timeout: 15))
        // Audit expanded sheets: at the medium detent rows run under the screen edge.
        app.swipeUp()
        try audit(app, "agents")
        app.buttons["Done"].firstMatch.tap()
        app.buttons["thread.changes"].tap()
        XCTAssertTrue(app.buttons["changes.step"].waitForExistence(timeout: 15))
        try audit(app, "changes")
        if app.buttons["Done"].firstMatch.exists { app.buttons["Done"].firstMatch.tap() } else { app.swipeDown(velocity: .fast) }
        back(app)
        app.buttons["inbox.machines"].tap()
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10))
        app.swipeUp()
        try audit(app, "machines")
        app.buttons["Done"].firstMatch.tap()
        app.buttons["inbox.settings"].tap()
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10))
        try audit(app, "settings")
        app.buttons["settings.archive"].tap()
        XCTAssertTrue(app.buttons["archive.ios-archived-44"].waitForExistence(timeout: 15))
        try audit(app, "archive")
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
    /// Every audit issue is listed in an attachment. Missing descriptions and small hit areas fail
    /// the test. Reported only: `.dynamicType` (the token fonts scale through `@ScaledMetric` into
    /// `.system(size:)`, which the audit can't see; the AX-size screenshots check scaling),
    /// contrast (the audit samples glass and blurred backdrops and flags full-ink text on them;
    /// token contrast is enforced by the theme tests), and titles the navigation bar truncates.
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons["thread.\(id)"]
        for _ in 0..<4 where !row.exists { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }
    private func back(_ app: XCUIApplication) {
        let button = app.buttons["BackButton"].firstMatch
        if button.waitForExistence(timeout: 5) { button.tap() }
        _ = app.buttons["inbox.settings"].waitForExistence(timeout: 10)
    }
    private func audit(_ app: XCUIApplication, _ name: String) throws {
        screenshot("audit-\(name)")
        var found: [String] = []
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            let line = "\(issue.auditType) \(element?.identifier ?? "-") '\(element?.label ?? "")': \(issue.compactDescription)"
            let blocking: XCUIAccessibilityAuditType = [.sufficientElementDescription, .hitRegion]
            let exempt = !blocking.contains(issue.auditType) || element == nil || element?.elementType == .navigationBar
                || issue.compactDescription.contains("nearly")
            found.append((exempt ? "exempt " : "ISSUE ") + line)
            if !exempt, let element {
                let shot = XCTAttachment(screenshot: element.screenshot())
                shot.name = "audit-\(name)-element-\(found.count)"
                shot.lifetime = .keepAlways
                self.add(shot)
            }
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
