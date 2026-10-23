import XCTest

/// New thread, Add project and Files against the spike fixture (`scripts/project-scenario.ts`),
/// with screenshots. Run on a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class NewThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testStartingAThreadWithAMentionOpensIt() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        screenshot("newthread-sheet")
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        screenshot("newthread-projects")
        app.buttons["project.ace"].tap()
        let agent = app.buttons["newThread.agent"]
        XCTAssertTrue(agent.waitForExistence(timeout: 10))
        agent.tap()
        // The sheet opens where the draft runs; Claude's first account is one tap away.
        showTab(app, "claude:claude-personal")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model.claude.")).firstMatch.waitForExistence(timeout: 15))
        // An agent whose sign-in expired says why in one line, and its models can't be picked.
        XCTAssertTrue(app.buttons["tab.favorites"].exists)
        let cursor = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tab.cursor")).firstMatch
        if cursor.exists {
            showTab(app, String(cursor.identifier.dropFirst("tab.".count)))
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier ENDSWITH %@", "tab.cursor", ".reason")).firstMatch.waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model.cursor.")).firstMatch.isEnabled)
        }
        screenshot("newthread-agents")
        showTab(app, "claude:claude-personal")
        // Pick a ready agent's model on screen; the sheet returns to the form with it.
        let models = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model."))
        let visible = (0..<min(models.count, 40)).map { models.element(boundBy: $0) }.first { $0.isHittable }
        XCTAssertNotNil(visible)
        visible?.tap()
        app.buttons["modelSheet.done"].tap()
        // The strip's Worktree box turns a worktree on; its base shows beside it.
        let worktree = app.buttons["newThread.worktree"]
        if worktree.waitForExistence(timeout: 10), worktree.isEnabled, worktree.value as? String == "Off" {
            worktree.tap()
            XCTAssertTrue(app.buttons["newThread.base"].waitForExistence(timeout: 10))
        }
        let message = element(app, "newThread.message")
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        message.tap()
        message.typeText("Tighten the outbox retry ")
        app.buttons["newThread.options"].tap()
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
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 30))
        screenshot("newthread-started")
    }

    func testAProfileCreatedFromTheDraftIsOfferedOnReturnAndSuppliesItsInstructions() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        app.buttons["newThread.options"].tap()
        app.buttons["newThread.instructionsPage"].tap()
        let manage = app.buttons["newThread.profiles"]
        for _ in 0..<8 where !manage.isHittable { app.swipeUp() }
        manage.tap()
        let create = app.buttons["New profile"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        let name = "Reviewer \(UUID().uuidString.prefix(6))"
        let instructions = "Check replay after a lost receipt."
        let field = app.textFields["Profile name"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(name)
        app.textViews["Profile instructions"].tap()
        app.textViews["Profile instructions"].typeText(instructions)
        app.buttons["profile.save"].tap()
        // Back from Profiles to the same draft: the picker reads the new profile at once.
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 5))
        app.navigationBars["Task profiles"].buttons.firstMatch.tap()
        let picker = element(app, "newThread.profile")
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        for _ in 0..<8 where !picker.isHittable { app.swipeUp() }
        picker.tap()
        let choice = app.buttons[name]
        XCTAssertTrue(choice.waitForExistence(timeout: 5))
        choice.tap()
        XCTAssertEqual(element(app, "newThread.instructions").value as? String, instructions)
        screenshot("newthread-profile")
    }

    func testTheFirstMessageOffersSpeedAccessAndFilesAndLongModelListsCollapse() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        app.buttons["project.ace"].tap()
        let agent = app.buttons["newThread.agent"]
        XCTAssertTrue(agent.waitForExistence(timeout: 10))
        agent.tap()
        // Codex's personal account lists many models: the lead show, the rest wait behind More models.
        showTab(app, "codex:codex-personal")
        let codexModels = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "model.codex."))
        XCTAssertTrue(codexModels.firstMatch.waitForExistence(timeout: 15))
        let lead = codexModels.count
        XCTAssertLessThanOrEqual(lead, 5)
        let more = app.buttons["agent.codex.more"]
        XCTAssertTrue(more.exists)
        screenshot("newthread-agents-collapsed")
        for _ in 0..<25 where !more.isHittable { app.swipeUp() }
        more.tap()
        XCTAssertTrue(app.buttons["agent.codex.fewer"].waitForExistence(timeout: 5))
        XCTAssertGreaterThan(codexModels.count, lead)
        screenshot("newthread-agents-more")
        // The demonstration model offers faster tiers.
        let tuned = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier CONTAINS[c] %@", "model.codex.", "ultra")).firstMatch
        for _ in 0..<25 where !tuned.isHittable { app.swipeUp() }
        tuned.tap()
        app.buttons["modelSheet.done"].tap()
        XCTAssertTrue(app.buttons["modelSheet.done"].waitForNonExistence(timeout: 10))
        // Effort and speed have their own panel from the model chip's effort part.
        XCTAssertTrue(app.buttons["newThread.tune"].waitForExistence(timeout: 10))
        app.buttons["newThread.tune"].tap()
        XCTAssertTrue(element(app, "newThread.speed").waitForExistence(timeout: 10))
        screenshot("newthread-tuning")
        app.otherElements["tunePanel"].swipeDown(velocity: .fast)
        XCTAssertTrue(element(app, "newThread.speed").waitForNonExistence(timeout: 10))
        // Access sits beside +: its menu lists each mode with what it does.
        let access = app.buttons["newThread.access"]
        XCTAssertTrue(access.waitForExistence(timeout: 15))
        access.tap()
        let readOnly = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Read-only")).firstMatch
        XCTAssertTrue(readOnly.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Full access")).firstMatch.waitForExistence(timeout: 5))
        screenshot("newthread-access-menu")
        readOnly.tap()
        expectation(for: NSPredicate(format: "value == %@", "Read-only"), evaluatedWith: app.buttons["newThread.access"])
        waitForExpectations(timeout: 10)
        // The compact composer keeps attachment next to the input.
        XCTAssertTrue(element(app, "newThread.attach").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "newThread.attach").isHittable)
        element(app, "newThread.attach").tap()
        XCTAssertTrue(app.buttons["Choose File"].waitForExistence(timeout: 5))
        screenshot("newthread-attach-menu")
    }

    func testAddingAFolderFromTheComputerSelectsItAsTheProject() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
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

    func testFilesOpensFoldersInPlaceAndMentionsAFileInTheComposer() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        // Done rows stay in the list until they are settled.
        for _ in 0..<10 where !app.buttons["thread.ios-done"].isHittable { app.swipeUp() }
        app.revealRow("thread.ios-done")
        app.buttons["thread.ios-done"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        app.buttons["thread.menu"].tap()
        app.buttons["thread.files"].tap()
        XCTAssertTrue(app.buttons["file.fixtures/"].waitForExistence(timeout: 15))
        screenshot("files-root")
        app.buttons["file.fixtures/"].tap()
        app.buttons["file.fixtures/snapshots/"].tap()
        XCTAssertTrue(app.buttons["file.fixtures/snapshots/case-000.json"].waitForExistence(timeout: 10))
        screenshot("files-open-folder")
        // Closing a folder hides everything under it.
        app.buttons["file.fixtures/"].tap()
        XCTAssertFalse(app.buttons["file.fixtures/snapshots/case-000.json"].exists)
        let logs = app.buttons["file.logs/"]
        for _ in 0..<10 where !logs.isHittable { app.swipeUp() }
        logs.tap()
        app.buttons["file.logs/relay.log"].tap()
        XCTAssertTrue(element(app, "preview.text").waitForExistence(timeout: 20))
        screenshot("files-preview")
        app.buttons["file.menu"].tap()
        XCTAssertTrue(app.buttons["preview.mention"].waitForExistence(timeout: 5))
        app.buttons["preview.mention"].tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue((input.value as? String)?.contains("@logs/relay.log") == true)
        screenshot("files-mentioned")
    }

    func testNewThreadBrowsesAndPreviewsTheProjectsFolderBeforeAThreadExists() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        app.buttons["project.ace"].tap()
        app.buttons["newThread.options"].tap()
        let browse = app.buttons["newThread.files"]
        XCTAssertTrue(browse.waitForExistence(timeout: 10))
        browse.tap()
        let docs = app.buttons["file.docs/"]
        XCTAssertTrue(docs.waitForExistence(timeout: 15))
        for _ in 0..<10 where !docs.isHittable { app.swipeUp() }
        screenshot("newthread-files-root")
        docs.tap()
        XCTAssertTrue(app.buttons["file.docs/runbook.md"].waitForExistence(timeout: 10))
        screenshot("newthread-files-folder")
        app.buttons["file.docs/runbook.md"].tap()
        XCTAssertTrue(element(app, "preview.markdown").waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Relay runbook"].exists)
        // A project's own folder is read-only before the thread exists.
        XCTAssertFalse(app.buttons["file.edit"].exists)
        screenshot("newthread-files-preview")
        app.buttons["file.menu"].tap()
        XCTAssertTrue(app.buttons["preview.mention"].waitForExistence(timeout: 5))
        app.buttons["preview.mention"].tap()
        let message = element(app, "newThread.message")
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue((message.value as? String)?.contains("@docs/runbook.md") == true)
        screenshot("newthread-files-mentioned")
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

    /// Shows one account's models from the model sheet's tab bar, scrolling the bar to its tab.
    private func showTab(_ app: XCUIApplication, _ id: String) {
        let chip = app.buttons["tab.\(id)"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        let chips = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tab."))
        for _ in 0..<6 where !chip.isHittable {
            let visible = (0..<chips.count).map { chips.element(boundBy: $0) }.first { $0.isHittable }
            if chip.frame.minX > app.frame.midX { visible?.swipeLeft() } else { visible?.swipeRight() }
        }
        chip.tap()
        XCTAssertTrue(chip.isSelected)
    }
}
