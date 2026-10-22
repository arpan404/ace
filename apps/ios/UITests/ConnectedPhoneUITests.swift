import XCTest

/// Opt-in checks on the owner's physical phone. Rendering fixtures never invoke providers.
@MainActor final class ConnectedPhoneUITests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ACE_IOS_CONNECTED_PHONE"] == "1", "Requires the connected paired iPhone")
        continueAfterFailure = false
    }
    func testSendingWhileRowsArriveKeepsTheAppOpenAndComposerVisible() {
        let app = XCUIApplication()
        app.launchArguments = ["--chat-render-fixture"]
        app.launch()
        XCTAssertTrue(app.textViews["composer.input"].waitForExistence(timeout: 20))
        for index in 0..<6 {
            let input = app.textViews["composer.input"]
            input.tap(); input.typeText("Phone send regression \(index)")
            app.buttons["composer.send"].tap()
            XCTAssertTrue(app.staticTexts["Acknowledged Phone send regression \(index)"].waitForExistence(timeout: 10))
            XCTAssertEqual(app.state, .runningForeground)
            XCTAssertTrue(input.isHittable)
            XCTAssertEqual(input.value as? String, "", "A confirmed send must clear its submitted draft")
            XCTAssertFalse(app.buttons["pending.retry"].exists)
            XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        }
        capture("send-during-incoming-rows", app)
    }
    func testLiveWorkShowsItsGroupsInPlaceAndAGroupOpensItsSteps() {
        let app = XCUIApplication()
        app.launchArguments = ["--chat-render-fixture", "--chat-work-fixture"]
        app.launch()
        let group = app.buttons["work.group.fixture-tools"]
        XCTAssertTrue(group.waitForExistence(timeout: 20))
        // A running turn has no fold of its own: its live "Working for" line carries the timer.
        XCTAssertFalse(app.buttons["work.toggle"].exists)
        XCTAssertTrue(app.staticTexts["Checking the phone result."].exists)
        XCTAssertFalse(app.staticTexts["Ran physical phone build"].exists)
        capture("working-in-place", app)
        group.tap()
        XCTAssertTrue(app.staticTexts["Ran physical phone build"].waitForExistence(timeout: 5))
        capture("working-group-open", app)
        group.tap()
        XCTAssertFalse(app.staticTexts["Ran physical phone build"].exists)
    }
    func testBrowseShowsProjectsAndMachineTools() {
        let app = launch()
        app.openSettings()
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
        let start = app.newThreadButton
        XCTAssertGreaterThan(start.frame.minY, app.frame.midY)
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
        XCTAssertGreaterThanOrEqual(send.frame.minY, message.frame.maxY)
        XCTAssertLessThanOrEqual(send.frame.maxY, app.keyboards.firstMatch.frame.minY)
        capture("new-task-keyboard", app)
        app.navigationBars.buttons["Close"].tap()
    }
    func testThreadKeepsModelFilesAndSendWithinTheComposer() {
        let app = launch()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30)); row.tap()
        XCTAssertTrue(app.buttons["composer.model"].waitForExistence(timeout: 30))
        waitForConversation(app)
        XCTAssertTrue(app.buttons["composer.attach"].isHittable)
        let model = app.buttons["composer.model"]
        let inputBeforeKeyboard = app.textViews["composer.input"]
        XCTAssertGreaterThanOrEqual(model.frame.minY, inputBeforeKeyboard.frame.maxY)
        XCTAssertGreaterThan(inputBeforeKeyboard.frame.width, app.frame.width * 0.8)
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
        app.buttons["composer.model"].tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 15))
        capture("thread-model-picker", app)
        app.closeSheet()
        let latest = app.buttons["transcript.latest"]
        // The first downward gesture can dismiss the keyboard. Continue into older messages.
        for _ in 0..<3 where !latest.exists { app.scrollViews["transcript"].swipeDown() }
        capture("thread-reading-history", app)
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        XCTAssertTrue(latest.waitForNonExistence(timeout: 5))
        capture("thread-latest", app)
    }
    func testOlderMessagesLoadInlineAndKeepTheReadingAnchor() {
        let app = XCUIApplication()
        app.launchArguments = ["--chat-render-fixture"]
        app.launch()
        let feed = app.scrollViews["transcript"]
        XCTAssertTrue(feed.waitForExistence(timeout: 20))
        let paging = app.descendants(matching: .any)["transcript.paging"]
        for _ in 0..<8 where !paging.exists { feed.swipeDown(velocity: .fast) }
        XCTAssertTrue(paging.waitForExistence(timeout: 5))
        let anchor = feed.staticTexts.allElementsBoundByIndex.first {
            $0.label.hasPrefix("Recorded conversation message") && $0.isHittable && $0.frame.minY >= feed.frame.minY
        }
        XCTAssertNotNil(anchor)
        let label = anchor?.label ?? ""
        let y = anchor?.frame.minY ?? 0
        XCTAssertTrue(paging.waitForNonExistence(timeout: 10))
        let kept = app.staticTexts[label]
        XCTAssertTrue(kept.exists)
        XCTAssertEqual(kept.frame.minY, y, accuracy: 3, "Prepending history must keep the same text at the same reading position")
        XCTAssertFalse(app.buttons["Earlier messages"].exists)
        XCTAssertEqual(feed.value as? String, "Reading history")
        capture("infinite-history-anchor", app)
        feed.swipeDown(velocity: .fast)
        XCTAssertTrue(paging.waitForExistence(timeout: 5))
        XCTAssertTrue(paging.waitForNonExistence(timeout: 10))
        app.buttons["transcript.latest"].tap()
        expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: feed)
        waitForExpectations(timeout: 10)
    }
    func testRealHistoryLoadsInlineWithoutLeavingTheComposer() {
        let app = launch()
        let current = app.buttons["thread.01a15b0e-7eef-705b-a011-fde54ae8afd1"]
        XCTAssertTrue(current.waitForExistence(timeout: 30)); current.tap()
        waitForConversation(app)
        let feed = app.scrollViews["transcript"]
        for _ in 0..<12 where feed.value as? String != "Reading history" { feed.swipeDown(velocity: .fast) }
        expectation(for: NSPredicate(format: "value == %@", "Reading history"), evaluatedWith: feed)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(app.buttons["Earlier messages"].exists)
        XCTAssertTrue(app.textViews["composer.input"].exists)
        capture("real-infinite-history", app)
        app.buttons["transcript.latest"].tap()
        expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: feed)
        waitForExpectations(timeout: 10)
    }
    func testMachineToolsLoadWithoutStartingAgentsOrDevices() {
        let app = launch()
        app.openSettings()
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
        XCTAssertTrue(app.buttons["thread.agents"].waitForExistence(timeout: 20))
        waitForConversation(app)
        let work = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 20))
        XCTAssertEqual(work.value as? String, "Collapsed")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "work.group.")).firstMatch.exists)
        XCTAssertLessThanOrEqual(work.frame.height, 49, "Collapsed work should occupy one touch-target row without extra cell padding")
        XCTAssertFalse(app.staticTexts["compaction"].exists)
        capture("live-grouped-work", app)
    }
    func testSourceControlAndCliSkillDiscoveryLoadFromTheSelectedMachine() {
        let app = launch()
        app.openSettings()
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
    func testComputerUseShowsMacPermissionsWithoutStartingCapture() {
        let app = launch()
        app.openSettings()
        let computer = app.buttons["library.computer"]
        if !computer.isHittable { app.swipeUp() }
        XCTAssertTrue(computer.waitForExistence(timeout: 10)); computer.tap()
        XCTAssertTrue(app.navigationBars["Computer use"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.switches["Let agents use apps"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Screen Recording"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Accessibility"].exists)
        capture("computer-use", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
        app.buttons["App access and device preferences"].tap()
        XCTAssertTrue(app.staticTexts["Apps agents can't use"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.switches["Show emulator window"].waitForExistence(timeout: 30))
        capture("app-access-preferences", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
    }
    func testProjectCreationAndCloneReadHostDefaultsWithoutCreatingAnything() {
        let app = launch()
        app.openSettings()
        app.buttons["library.projects"].tap()
        let add = app.buttons["Add project"]
        if !add.isHittable { app.swipeUp() }
        XCTAssertTrue(add.waitForExistence(timeout: 10)); add.tap()
        app.buttons["New project"].tap()
        let parent = app.textFields["project.create.parent"]
        XCTAssertTrue(parent.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "value BEGINSWITH '/' OR value BEGINSWITH '~'")
        expectation(for: ready, evaluatedWith: parent)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(app.switches["Initialise a Git repository"].exists)
        XCTAssertTrue(app.textFields["project.create.name"].isHittable)
        capture("new-project", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
        app.navigationBars.buttons["BackButton"].firstMatch.tap()
        app.buttons["Clone repository"].tap()
        XCTAssertTrue(app.textFields["project.clone.url"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["project.create.submit"].exists)
        capture("clone-project", app)
        XCTAssertFalse(app.staticTexts["service.problem"].exists)
    }
    private func waitForConversation(_ app: XCUIApplication) {
        let transcript = app.scrollViews["transcript"]
        expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: transcript)
        waitForExpectations(timeout: 30)
        XCTAssertFalse(app.descendants(matching: .any)["transcript.loading"].exists)
        if app.buttons["thread.fileChip"].exists {
            XCTAssertLessThanOrEqual(app.buttons["thread.fileChip"].frame.height, 49, "The file summary must not add a padded empty row above the composer")
        }
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View work")).firstMatch.exists)
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        if !app.buttons["inbox.settings"].waitForExistence(timeout: 45) {
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
