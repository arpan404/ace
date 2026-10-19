import XCTest

/// New thread, Add project and Files against the spike fixture (`scripts/project-scenario.ts`),
/// with screenshots. Run on a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class NewThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testStartingAThreadWithAMentionOpensIt() {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.compose"].waitForExistence(timeout: 25))
        app.buttons["inbox.compose"].tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        screenshot("newthread-sheet")
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        screenshot("newthread-projects")
        app.buttons["project.ace"].tap()
        let agent = app.buttons["newThread.agent"]
        XCTAssertTrue(agent.waitForExistence(timeout: 10))
        agent.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model.claude.")).firstMatch.waitForExistence(timeout: 15))
        for _ in 0..<25 where !element(app, "agent.cursor.reason").isHittable { app.swipeUp() }
        XCTAssertTrue(element(app, "agent.cursor.reason").exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model.cursor.")).firstMatch.exists)
        screenshot("newthread-agents")
        // Pick a ready agent's model on screen; the sheet returns to the form with it.
        let models = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model."))
        let visible = (0..<min(models.count, 40)).map { models.element(boundBy: $0) }.first { $0.isHittable }
        XCTAssertNotNil(visible)
        visible?.tap()
        let worktree = app.switches["newThread.worktree"]
        if worktree.waitForExistence(timeout: 10), worktree.isEnabled { worktree.switches.firstMatch.tap() }
        let message = element(app, "newThread.message")
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        message.tap()
        message.typeText("Tighten the outbox retry ")
        app.buttons["newThread.mention"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("outbox")
        let file = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "mention.", "outbox.ts")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15))
        screenshot("newthread-mention")
        file.tap()
        XCTAssertTrue(app.buttons["newThread.start"].waitForExistence(timeout: 5))
        screenshot("newthread-ready")
        app.buttons["newThread.start"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.header"].waitForExistence(timeout: 30))
        screenshot("newthread-started")
    }

    func testAddingAFolderFromTheComputerSelectsItAsTheProject() {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.compose"].waitForExistence(timeout: 25))
        app.buttons["inbox.compose"].tap()
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["projects.add"].waitForExistence(timeout: 15))
        app.buttons["projects.add"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("notes")
        XCTAssertTrue(app.buttons["folder.notes"].waitForExistence(timeout: 15))
        screenshot("addproject-search")
        app.buttons["folder.notes"].tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "newThread.project", "notes")).firstMatch.waitForExistence(timeout: 15))
        screenshot("addproject-selected")
    }

    func testFilesListsAFolderWithinItsCapAndPreviewsTheStartOfALargeFile() {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.compose"].waitForExistence(timeout: 25))
        for _ in 0..<8 where !app.buttons["inbox.settled"].isHittable { app.swipeUp() }
        if !app.buttons["thread.ios-done"].exists { app.buttons["inbox.settled"].tap() }
        for _ in 0..<6 where !app.buttons["thread.ios-done"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["thread.ios-done"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-done"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        app.buttons["thread.menu"].tap()
        app.buttons["thread.files"].tap()
        XCTAssertTrue(app.buttons["file.fixtures/"].waitForExistence(timeout: 15))
        screenshot("files-root")
        app.buttons["file.fixtures/"].tap()
        app.buttons["file.fixtures/snapshots/"].tap()
        XCTAssertTrue(element(app, "files.more").waitForExistence(timeout: 15) || scrollToMore(app))
        screenshot("files-capped")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["file.logs/"].waitForExistence(timeout: 10))
        app.buttons["file.logs/"].tap()
        app.buttons["file.logs/relay.log"].tap()
        XCTAssertTrue(element(app, "preview.text").waitForExistence(timeout: 20))
        screenshot("files-preview")
        XCTAssertTrue(app.buttons["preview.mention"].waitForExistence(timeout: 5))
        app.buttons["preview.mention"].tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue((input.value as? String)?.contains("@logs/relay.log") == true)
        screenshot("files-mentioned")
    }

    private func scrollToMore(_ app: XCUIApplication) -> Bool {
        for _ in 0..<30 where !element(app, "files.more").exists { app.swipeUp(velocity: .fast) }
        return element(app, "files.more").exists
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
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
