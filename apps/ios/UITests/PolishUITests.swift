import XCTest

/// Settings, the archive, the offline snooze end and the accessibility audit against the spike
/// fixture (`scripts/archive-scenario.ts`). `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port;
/// `TEST_RUNNER_ACE_IOS_TEXT_SIZE` (a UIContentSizeCategory name) runs them at another text size.
@MainActor final class PolishUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    func testSettingsHoldPerMachineNotificationsLicencesAndDiagnostics() throws {
        let app = launch()
        app.openBrowseDestination("inbox.settings")
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
        app.openBrowseDestination("inbox.settings")
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
        let snoozed = app.buttons["inbox.snoozed"].firstMatch
        for _ in 0..<6 where !snoozed.isHittable { app.swipeUp() }
        snoozed.tap()
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
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        try audit(app, "new-thread")
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["projects.add"].waitForExistence(timeout: 15))
        try audit(app, "projects")
        app.buttons["BackButton"].firstMatch.tap()
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 10))
        open("ios-plan", in: app)
        XCTAssertTrue(app.buttons["plan.approve"].waitForExistence(timeout: 25))
        try audit(app, "plan-card")
        back(app)
        open("ios-form", in: app)
        XCTAssertTrue(app.buttons["form.submit"].waitForExistence(timeout: 25))
        try audit(app, "form-card")
        back(app)
        open("ios-agents", in: app)
        // The transcript opens at its end; at large sizes the turn's head is screens above it.
        let worked = app.buttons["work.toggle"].firstMatch
        if reveal(worked, in: app, up: 0, down: 24) {
            worked.tap()
            _ = app.staticTexts["Ran"].waitForExistence(timeout: 15)
            try audit(app, "steps")
        }
        back(app)
        dismissStrayError(app)
        openTree(app)
        try audit(app, "thread")
        try auditAgents(app)
        try auditChanges(app)
        app.buttons["thread.menu"].tap()
        app.buttons["thread.files"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'file.'")).firstMatch.waitForExistence(timeout: 15))
        try audit(app, "files")
        app.buttons["Done"].firstMatch.tap()
        back(app)
        try auditMachines(app)
        try auditSettings(app)
    }

    /// The sheets' own screens: an agent's transcript, a file's diff, the commit editor, a
    /// machine's detail, notification settings per machine, and the licences.
    func testSubScreensPassTheAccessibilityAudit() throws {
        continueAfterFailure = true
        let app = launch()
        openTree(app)
        app.openAgents()
        XCTAssertTrue(app.buttons["agents.stopAll"].waitForExistence(timeout: 15))
        let explorer = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'agents.row.' AND label CONTAINS 'Explorer'")).firstMatch
        if reveal(explorer, in: app, up: 8, down: 0) {
            explorer.tap()
            XCTAssertTrue(app.descendants(matching: .any)["agents.transcript"].waitForExistence(timeout: 15))
            try audit(app, "agent-transcript")
            // The thread behind the sheet has its own back button; use the sheet's.
            app.navigationBars["Explorer"].buttons["BackButton"].tap()
        }
        app.buttons["Done"].firstMatch.tap()
        app.buttons["thread.changes"].tap()
        let file = app.buttons["changes.file.packages/provider-kit/src/process-owner.ts"]
        XCTAssertTrue(file.waitForExistence(timeout: 15))
        file.tap()
        XCTAssertTrue(app.descendants(matching: .any)["diff.view"].waitForExistence(timeout: 10))
        try audit(app, "diff")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(reveal(app.buttons["changes.step"], in: app, up: 8, down: 0))
        app.buttons["changes.step"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes.text"].waitForExistence(timeout: 10))
        try audit(app, "commit-editor")
        // At the default size the audit can close the half-height editor itself.
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.waitForExistence(timeout: 3) { cancel.tap() }
        app.buttons["Done"].firstMatch.tap()
        back(app)
        app.openBrowseDestination("inbox.machines")
        let machine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'machines.row.'")).firstMatch
        XCTAssertTrue(machine.waitForExistence(timeout: 10))
        machine.tap()
        XCTAssertTrue(app.descendants(matching: .any)["machine.connection"].waitForExistence(timeout: 10))
        try audit(app, "machine-detail")
        try auditBelow(app, "machine-detail")
        app.buttons["BackButton"].firstMatch.tap()
        app.buttons["Done"].firstMatch.tap()
        app.openBrowseDestination("inbox.settings")
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10))
        app.buttons["settings.notifications"].tap()
        let perMachine = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'notifications.machine.'")).firstMatch
        XCTAssertTrue(perMachine.waitForExistence(timeout: 10))
        try audit(app, "notifications")
        if reveal(perMachine, in: app, up: 8, down: 0) {
            perMachine.tap()
            XCTAssertTrue(app.descendants(matching: .any)["notifications.quiet"].waitForExistence(timeout: 10))
            try audit(app, "machine-notifications")
            app.buttons["BackButton"].firstMatch.tap()
        }
        app.buttons["BackButton"].firstMatch.tap()
        let licences = app.buttons["settings.licences"]
        XCTAssertTrue(reveal(licences, in: app, up: 12, down: 0))
        licences.tap()
        XCTAssertTrue(app.staticTexts["Zod"].waitForExistence(timeout: 5))
        try audit(app, "licences")
    }

    // MARK: Audited screens

    private func auditAgents(_ app: XCUIApplication) throws {
        app.openAgents()
        XCTAssertTrue(app.buttons["agents.stopAll"].waitForExistence(timeout: 15))
        // Audit the full-height sheet: at the half detent rows run under the screen edge. At
        // accessibility sizes it opens full height, and this drag on its bar changes nothing.
        app.navigationBars["Agents"].swipeUp()
        try audit(app, "agents")
        try auditBelow(app, "agents")
        let stopTask = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'agents.task.stop.'")).firstMatch
        XCTAssertTrue(reveal(stopTask, in: app, up: 10, down: 0))
        try audit(app, "agents-tasks")
        app.buttons["Done"].firstMatch.tap()
    }
    private func auditChanges(_ app: XCUIApplication) throws {
        app.buttons["thread.changes"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["changes.totals"].waitForExistence(timeout: 15))
        try audit(app, "changes")
        try auditBelow(app, "changes")
        // At accessibility sizes the next step ends the list rather than floating over it.
        XCTAssertTrue(reveal(app.buttons["changes.step"], in: app, up: 8, down: 0))
        try audit(app, "changes-step")
        app.buttons["Done"].firstMatch.tap()
    }
    private func auditMachines(_ app: XCUIApplication) throws {
        app.openBrowseDestination("inbox.machines")
        XCTAssertTrue(app.navigationBars["Machines"].waitForExistence(timeout: 10))
        app.navigationBars["Machines"].swipeUp()
        try audit(app, "machines")
        try auditBelow(app, "machines")
        app.buttons["Done"].firstMatch.tap()
    }
    private func auditSettings(_ app: XCUIApplication) throws {
        app.openBrowseDestination("inbox.settings")
        XCTAssertTrue(app.buttons["settings.notifications"].waitForExistence(timeout: 10))
        try audit(app, "settings")
        try auditBelow(app, "settings")
        let archive = app.buttons["settings.archive"]
        XCTAssertTrue(reveal(archive, in: app, up: 12, down: 0))
        archive.tap()
        XCTAssertTrue(app.buttons["archive.ios-archived-44"].waitForExistence(timeout: 15))
        try audit(app, "archive")
    }
    /// At accessibility sizes a screen's later rows sit below the screen edge; audit them too.
    private func auditBelow(_ app: XCUIApplication, _ name: String) throws {
        guard ProcessInfo.processInfo.environment["ACE_IOS_TEXT_SIZE"]?.contains("Accessibility") == true else { return }
        drag(app, from: 0.5, to: 0.15) // Above a floating card, which doesn't scroll.
        try audit(app, "\(name)-lower")
    }

    // MARK: Helpers

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        if let size = ProcessInfo.processInfo.environment["ACE_IOS_TEXT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        // At accessibility text sizes the first rows can already fill the screen.
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        return app
    }
    /// Every audit issue is listed in an attachment. Missing descriptions and small hit areas fail
    /// the test. Reported only: `.dynamicType` (the token fonts scale through `@ScaledMetric` into
    /// `.system(size:)`, which the audit can't see; the AX-size screenshots check scaling),
    /// contrast (the audit samples glass and blurred backdrops and flags full-ink text on them;
    /// token contrast is enforced by the theme tests), and titles the navigation bar truncates.
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons["thread.\(id)"]
        XCTAssertTrue(reveal(row, in: app, up: 20, down: 0) || reveal(row, in: app, up: 0, down: 30), id)
        row.tap()
    }
    /// Scrolling a transcript to its top and leaving can race a history request past `back`, and
    /// the bridge reports it as a failed request. That race isn't what this audit covers: note it
    /// and close the alert so the next screens can be reached.
    private func dismissStrayError(_ app: XCUIApplication) {
        let alert = app.alerts["Request needs attention"]
        guard alert.waitForExistence(timeout: 2) else { return }
        let note = XCTAttachment(string: alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n"))
        note.name = "stray-request-error.txt"
        note.lifetime = .keepAlways
        add(note)
        alert.buttons["OK"].tap()
    }
    private func openTree(_ app: XCUIApplication) {
        open("ios-tree", in: app)
        XCTAssertTrue(app.buttons["thread.agents"].waitForExistence(timeout: 15))
    }
    /// Swipes until `element` can be tapped: `up` swipes towards later content, then `down`
    /// towards earlier. At accessibility text sizes a row can sit screens away, or exist under a
    /// bar without being hittable. A row counts once its centre is clear of the bars.
    @discardableResult private func reveal(_ element: XCUIElement, in app: XCUIApplication, up: Int, down: Int) -> Bool {
        _ = element.waitForExistence(timeout: 3)
        let clear = CGRect(x: 0, y: app.frame.height * 0.15, width: app.frame.width, height: app.frame.height * 0.8)
        let shown = { element.exists && element.isHittable && clear.contains(CGPoint(x: element.frame.midX, y: element.frame.midY)) }
        for _ in 0..<up where !shown() { drag(app, from: 0.7, to: 0.4) }
        for _ in 0..<down where !shown() { drag(app, from: 0.4, to: 0.7) }
        return shown()
    }
    /// A held drag moves content by a known 30% of the screen, without momentum, so a step can't
    /// carry an element past the clear area `reveal` checks.
    private func drag(_ app: XCUIApplication, from: CGFloat, to: CGFloat) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
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
                // A file's name is its label; the audit reads "README.md" as not human-readable.
                || (element?.identifier.hasPrefix("file.") == true && issue.auditType == .sufficientElementDescription)
                // So is a diff's title ("process-owner.ts").
                || (issue.auditType == .sufficientElementDescription && element?.label.range(of: #"^[\w.-]+\.\w+$"#, options: .regularExpression) != nil)
                // Diff lines are selectable text, not controls; a 44-pt row per code line would
                // break the diff's density.
                || (issue.auditType == .hitRegion && element?.label.range(of: #"^(Added|Removed|Unchanged) line \d+:"#, options: .regularExpression) != nil)
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
