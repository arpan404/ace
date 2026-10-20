import XCTest

/// Opt-in checks on the owner's paired physical phone. No fixture or provider invocation.
@MainActor final class ConnectedPhoneUITests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ACE_IOS_CONNECTED_PHONE"] == "1", "Requires the connected paired iPhone")
        continueAfterFailure = false
    }
    func testBrowseShowsProjectsAndMachineTools() {
        let app = launch()
        app.buttons["inbox.library"].tap()
        XCTAssertTrue(app.buttons["library.projects"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Automations"].exists)
        XCTAssertTrue(app.buttons["Usage"].exists)
        XCTAssertTrue(app.buttons["library.devices"].exists)
        capture("browse", app)
        app.buttons["library.projects"].tap()
        XCTAssertTrue(app.navigationBars["Projects"].waitForExistence(timeout: 10))
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "projects.row.")).firstMatch
        let found = project.waitForExistence(timeout: 30)
        capture("projects", app)
        XCTAssertTrue(found, "The paired machine should return projects")
        XCTAssertFalse(app.descendants(matching: .any)["service.problem"].exists)
        capture("projects", app)
    }
    func testSearchFindsConversationContentOnThePairedMachine() {
        let app = launch()
        app.buttons["inbox.search"].tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText("ios")
        let hit = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "search.hit.")).firstMatch
        let found = hit.waitForExistence(timeout: 30)
        capture("search", app)
        XCTAssertTrue(found, "Search must read the daemon index")
        XCTAssertFalse(app.descendants(matching: .any)["service.problem"].exists)
        capture("search", app)
    }
    func testNewTaskKeepsMessageAndChoicesReachableAboveTheKeyboard() {
        let app = launch()
        let start = app.buttons["inbox.startTask"]
        let filter = app.buttons["inbox.projects"]
        XCTAssertLessThan(abs(start.frame.midY - filter.frame.midY), 8)
        XCTAssertGreaterThan(start.frame.midX, filter.frame.midX)
        XCTAssertLessThan(start.frame.maxY, app.frame.midY)
        start.tap()
        capture("new-task-idle", app)
        let message = app.textFields["newThread.message"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue(message.isHittable)
        message.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let send = app.buttons["newThread.start"]
        XCTAssertLessThanOrEqual(message.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertTrue(send.isHittable)
        XCTAssertLessThan(abs(send.frame.midY - message.frame.midY), 30)
        capture("new-task-keyboard", app)
        app.navigationBars.buttons["Close"].tap()
    }
    func testThreadKeepsModelFilesAndSendWithinTheComposer() {
        let app = launch()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30)); row.tap()
        XCTAssertTrue(app.buttons["composer.model"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["composer.attach"].isHittable)
        capture("thread-idle", app)
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.isHittable); input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("thread-keyboard", app)
        XCTAssertTrue(app.buttons["composer.model"].isHittable)
        XCTAssertTrue(app.buttons["composer.attach"].isHittable)
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertLessThan(abs(app.buttons["composer.model"].frame.midY - app.buttons["composer.attach"].frame.midY), 8)
        capture("thread-keyboard", app)
    }
    func testMachineToolsLoadWithoutStartingAgentsOrDevices() {
        let app = launch()
        app.buttons["inbox.library"].tap()
        let destinations = ["Skills and plugins", "Automations", "Usage", "Simulators and devices"]
        for title in destinations {
            let destination = app.buttons[title]
            if !destination.isHittable { app.swipeUp() }
            XCTAssertTrue(destination.waitForExistence(timeout: 10)); destination.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
            let reading = app.activityIndicators.firstMatch
            if reading.exists { XCTAssertTrue(reading.waitForNonExistence(timeout: 30)) }
            capture("tools-\(title)", app)
            XCTAssertFalse(app.staticTexts["service.problem"].exists)
            app.navigationBars.buttons["BackButton"].firstMatch.tap()
        }
    }
    func testCurrentConversationShowsGroupedWorkAndReadableNarration() {
        let app = launch()
        let current = app.buttons["thread.01a15b0e-7eef-705b-a011-fde54ae8afd1"]
        XCTAssertTrue(current.waitForExistence(timeout: 30)); current.tap()
        XCTAssertTrue(app.buttons["thread.work"].waitForExistence(timeout: 20))
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "work.group.")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["compaction"].exists)
        capture("live-grouped-work", app)
    }
    func testSourceControlAndCliSkillDiscoveryLoadFromTheSelectedMachine() {
        let app = launch()
        app.buttons["inbox.library"].tap()
        let source = app.buttons["Source control"]
        if !source.isHittable { app.swipeUp() }
        XCTAssertTrue(source.waitForExistence(timeout: 10)); source.tap()
        XCTAssertTrue(app.navigationBars["Source control"].waitForExistence(timeout: 10))
        let readiness = app.staticTexts["GitHub API"]
        XCTAssertTrue(readiness.waitForExistence(timeout: 30))
        capture("source-control", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
        app.navigationBars.buttons["BackButton"].firstMatch.tap()
        app.buttons["library.skills"].tap()
        XCTAssertTrue(app.buttons["skills.discovery"].waitForExistence(timeout: 10)); app.buttons["skills.discovery"].tap()
        let entry = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "skills.entry.")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 30))
        capture("cli-skills", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        if !app.buttons["inbox.library"].waitForExistence(timeout: 45) {
            capture("launch-needs-attention", app)
            XCTFail("Unlock ace on the connected iPhone and check its paired-machine connection")
        }
        return app
    }
    private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "iphone-\(name)"; shot.lifetime = .keepAlways; add(shot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "iphone-\(name)-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
}
