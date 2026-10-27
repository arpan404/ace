import XCTest

/// Settings › Automations against the spike fixture's automations (`scripts/automations-scenario.ts`):
/// the list, an automation's page with its runs and their threads, the friendly schedule editor,
/// GitHub and file triggers, and Duplicate. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS`
/// (a folder) also saves each screenshot there as `automations-<name>.png`.
@MainActor final class AutomationsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheListOpensAnAutomationWhoseRunsLeadToTheirThreads() throws {
        let app = launchIntoAutomations()
        XCTAssertTrue(app.buttons["automations.new"].waitForExistence(timeout: 20))
        let nightly = app.buttons["automation.row.auto-nightly"]
        reveal(app, nightly)
        screenshot("list")
        let prs = app.buttons["automation.row.auto-prs"]
        reveal(app, prs)
        XCTAssertTrue(prs.label.contains("Not watching"))
        reveal(app, nightly)
        nightly.tap()
        let when = element(app, "automation.when")
        XCTAssertTrue(when.waitForExistence(timeout: 10))
        // The schedule's zone shows when it isn't the phone's.
        XCTAssertTrue(when.label.hasPrefix("Every day at 2:00 AM"), when.label)
        screenshot("detail")
        // The run waiting on an approval says so; it never reads as working or done.
        let asking = element(app, "automation.run.run-nightly-4")
        reveal(app, asking)
        XCTAssertTrue(asking.label.contains("Needs you"))
        let failed = element(app, "automation.run.run-nightly-2")
        reveal(app, failed)
        XCTAssertTrue(failed.label.contains("Failed"))
        XCTAssertTrue(app.buttons["automation.run.again.run-nightly-2"].exists)
        screenshot("runs")
        let open = app.buttons["automation.run.open.run-nightly-3"]
        reveal(app, open)
        open.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Two packages are out of date")).firstMatch
            .waitForExistence(timeout: 20))
        screenshot("run-thread")
    }

    func testAWeeklyScheduleIsPickedWithFriendlyControlsAndShowsItsNextStarts() throws {
        let app = launchIntoAutomations()
        XCTAssertTrue(app.buttons["automations.new"].waitForExistence(timeout: 20))
        app.buttons["automations.new"].tap()
        let title = app.textFields["automation.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        title.tap()
        title.typeText("Weekly report")
        let prompt = app.textViews["automation.prompt"].exists ? app.textViews["automation.prompt"] : app.textFields["automation.prompt"]
        prompt.tap()
        prompt.typeText("Summarise what merged this week")
        screenshot("new")
        choose(app, "automation.cadence", "Weekly")
        choose(app, "automation.day", "Friday")
        let summary = element(app, "automation.summary")
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        let predicate = NSPredicate(format: "label BEGINSWITH %@", "Fridays at")
        expectation(for: predicate, evaluatedWith: summary)
        waitForExpectations(timeout: 10)
        reveal(app, element(app, "automation.nextStarts"))
        screenshot("weekly")
        choose(app, "automation.cadence", "Once")
        XCTAssertTrue(element(app, "automation.at").waitForExistence(timeout: 10))
        screenshot("once")
        choose(app, "automation.cadence", "Custom")
        let expression = app.textFields["automation.expression"]
        XCTAssertTrue(expression.waitForExistence(timeout: 10))
        expression.tap()
        expression.typeText("FREQ=BOGUS")
        app.buttons["automation.save"].tap()
        XCTAssertTrue(element(app, "automation.problem").waitForExistence(timeout: 10))
        screenshot("custom-problem")
        app.buttons["automation.cancel"].tap()
    }

    func testGitHubAndFileTriggersAreMadeOnThePhone() throws {
        let app = launchIntoAutomations()
        XCTAssertTrue(app.buttons["automations.new"].waitForExistence(timeout: 20))
        app.buttons["automations.new"].tap()
        let title = app.textFields["automation.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        title.tap()
        title.typeText("Label triage")
        let prompt = app.textViews["automation.prompt"].exists ? app.textViews["automation.prompt"] : app.textFields["automation.prompt"]
        prompt.tap()
        prompt.typeText("Triage the labelled issue")
        choose(app, "automation.trigger", "On pull requests or issues")
        let repository = app.textFields["automation.repository"]
        reveal(app, repository)
        repository.tap()
        repository.typeText("arpan404/ace")
        choose(app, "automation.event", "When an issue is labelled")
        let label = app.textFields["automation.label"]
        XCTAssertTrue(label.waitForExistence(timeout: 10))
        label.tap()
        label.typeText("needs-triage")
        screenshot("github")
        choose(app, "automation.trigger", "When files change")
        let paths = app.textViews["automation.paths"].exists ? app.textViews["automation.paths"] : app.textFields["automation.paths"]
        XCTAssertTrue(paths.waitForExistence(timeout: 10))
        paths.tap()
        paths.typeText("docs/**/*.md")
        screenshot("files")
        app.buttons["automation.save"].tap()
        let when = element(app, "automation.when")
        XCTAssertTrue(when.waitForExistence(timeout: 20))
        XCTAssertEqual(when.label, "When docs/**/*.md change")
        screenshot("saved")
        // Duplicate opens a paused copy.
        let duplicate = app.buttons["automation.duplicate"]
        reveal(app, duplicate)
        duplicate.tap()
        XCTAssertTrue(app.navigationBars["Label triage copy"].waitForExistence(timeout: 20))
        screenshot("duplicate")
    }

    func testTheEditorUsesTheSharedModelPicker() throws {
        let app = launchIntoAutomations()
        XCTAssertTrue(app.buttons["automations.new"].waitForExistence(timeout: 20))
        let nightly = app.buttons["automation.row.auto-nightly"]
        reveal(app, nightly)
        nightly.tap()
        let edit = app.buttons["automation.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        edit.tap()
        let model = app.buttons["automation.model"]
        XCTAssertTrue(model.waitForExistence(timeout: 15))
        screenshot("edit")
        model.tap()
        // New thread's own picker: its tabs and Close.
        XCTAssertTrue(app.buttons["modelSheet.close"].waitForExistence(timeout: 20))
        screenshot("model-picker")
    }

    // MARK: Helpers

    private func launchIntoAutomations() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        app.openBrowseDestination("library.automations")
        return app
    }
    /// Picks `label` in the menu picker `identifier`.
    private func choose(_ app: XCUIApplication, _ identifier: String, _ label: String) {
        let picker = element(app, identifier)
        reveal(app, picker)
        XCTAssertTrue(picker.exists, "\(identifier) never showed")
        picker.tap()
        let option = app.buttons[label].firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), "\(label) isn't offered in \(identifier)")
        option.tap()
    }
    /// Short slow drags, down the list then back up, until `target` shows clear of the bars.
    private func reveal(_ app: XCUIApplication, _ target: XCUIElement) {
        let top = app.frame.height * 0.15, bottom = app.frame.height * 0.8
        for attempt in 0..<16 {
            if target.waitForExistence(timeout: attempt == 0 ? 3 : 1), target.isHittable,
               target.frame.minY > top, target.frame.maxY < bottom { return }
            let below = !target.exists ? attempt < 8 : target.frame.minY >= bottom
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.65 : 0.35))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: below ? 0.4 : 0.6))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.1)
        }
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-automations-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("automations-\(name).png"))
        }
    }
}
