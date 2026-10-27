import XCTest

/// A native subagent's own page (prompt, requests, Stop, Ask parent to retry) and the Agents
/// sheet's pages for a large tree, against the spike fixture's `ios-subagents` and `ios-big-tree`
/// threads. Run on a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port and
/// `TEST_RUNNER_ACE_IOS_SHOTS` a folder for the screenshots.
@MainActor final class AgentsGapsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testFailedSubagentAsksItsParentToRetry() {
        let app = launch()
        open("ios-subagents", in: app)
        app.openAgents()
        let auditor = agentRow("Auditor", in: app)
        XCTAssertTrue(auditor.waitForExistence(timeout: 25))
        screenshot("agents-sheet-subagents")
        auditor.tap()
        // What its parent asked, as the person's bubble, and how its branch ended.
        XCTAssertTrue(app.descendants(matching: .any)["subagent.prompt"].waitForExistence(timeout: 15))
        let state = app.descendants(matching: .any)["subagent.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 10))
        XCTAssertTrue(state.label.hasPrefix("Failed"), state.label)
        let retry = app.buttons["subagent.retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        XCTAssertEqual(retry.label, "Ask parent to retry")
        XCTAssertFalse(app.buttons["subagent.stop"].exists)
        screenshot("subagent-failed")
        retry.tap()
        // The root's turn ended, so the message starts a turn: sent, not queued. The subagent
        // itself still reads failed until its parent runs it again.
        XCTAssertTrue(app.descendants(matching: .any)["subagent.retried"].waitForExistence(timeout: 15))
        XCTAssertTrue(state.label.hasPrefix("Failed"), state.label)
        screenshot("subagent-retry-sent")
    }

    func testSubagentWaitingOnTheBranchShowsItsRequestAndStop() {
        let app = launch()
        open("ios-subagents", in: app)
        app.openAgents()
        let migrator = agentRow("Migrator", in: app)
        XCTAssertTrue(migrator.waitForExistence(timeout: 25))
        migrator.tap()
        // Its own turn ended, but the subagent under it asks the person: never done.
        let state = app.descendants(matching: .any)["subagent.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 15))
        XCTAssertEqual(state.label, "Waiting on you")
        XCTAssertTrue(app.staticTexts["Drop the old owner table after the copy?"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["subagent.stop"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["subagent.retry"].exists)
        screenshot("subagent-waiting-request")
        app.buttons["subagent.stop"].tap()
        // One subagent stops with it, so it asks first.
        XCTAssertTrue(app.buttons["subagent.confirmStop"].waitForExistence(timeout: 10))
        screenshot("subagent-stop-confirm")
    }

    func testLargeTreePagesInOnThePhone() {
        let app = launch()
        open("ios-big-tree", in: app)
        app.openAgents()
        let more = app.buttons["agents.more"]
        XCTAssertTrue(reveal(more, in: app), "Show more below the first page")
        XCTAssertTrue(more.label.contains("Show 62 more") || more.label.contains("Show 63 more"), more.label)
        screenshot("agents-big-tree-page")
        more.tap()
        XCTAssertTrue(more.waitForNonExistence(timeout: 15), "every agent shows after one more page")
        let tasks = app.buttons["agents.tasks.more"]
        XCTAssertTrue(reveal(tasks, in: app), "Show more under the background tasks")
        tasks.tap()
        XCTAssertTrue(tasks.waitForNonExistence(timeout: 15))
        screenshot("agents-big-tree-all")
    }

    func testLogsFilterByLevelAndOpenForOneSubagent() {
        let app = launch()
        open("ios-subagents", in: app)
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.logs").tap()
        XCTAssertTrue(app.descendants(matching: .any)["logs.list"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'subagent'")).firstMatch.waitForExistence(timeout: 15))
        screenshot("logs-thread")
        app.buttons["logs.level"].tap()
        app.buttons["Errors only"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'failed'")).firstMatch.waitForExistence(timeout: 15))
        screenshot("logs-errors-only")
        app.buttons["Done"].tap()
        app.openAgents()
        let auditor = agentRow("Auditor", in: app)
        XCTAssertTrue(auditor.waitForExistence(timeout: 25))
        auditor.tap()
        XCTAssertTrue(app.buttons["subagent.log"].waitForExistence(timeout: 15))
        app.buttons["subagent.log"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["logs.list"].waitForExistence(timeout: 15))
        screenshot("logs-subagent")
    }

    func testOffshiftRunShowsBlockerStepsAndCriteria() {
        let app = launch()
        open("ios-subagents", in: app)
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.offshift").tap()
        let state = app.descendants(matching: .any)["offshift.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 15))
        // A subagent in the tree asks the person, which speaks before the run's blocker.
        XCTAssertTrue(state.label.hasPrefix("Answer"), state.label)
        XCTAssertTrue(app.descendants(matching: .any)["offshift.blocker"].exists)
        screenshot("offshift-blocked")
        app.swipeUp(velocity: .slow)
        screenshot("offshift-criteria")
    }

    func testDeliveredRunReadsWorkingWhileItsTreeWorks() {
        let app = launch()
        open("ios-big-tree", in: app)
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.offshift").tap()
        let state = app.descendants(matching: .any)["offshift.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 15))
        XCTAssertTrue(state.label.contains("Working"), state.label)
        XCTAssertFalse(state.label.contains("Done"), state.label)
        screenshot("offshift-delivered-working")
    }

    private func agentRow(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'agents.row.' AND label CONTAINS %@", name)).firstMatch
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<40 {
            if element.exists && element.isHittable { return true }
            app.swipeUp(velocity: .slow)
        }
        return element.exists && element.isHittable
    }
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons["thread.\(id)"]
        for _ in 0..<6 where !row.waitForExistence(timeout: 5) { app.swipeUp() }
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
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
