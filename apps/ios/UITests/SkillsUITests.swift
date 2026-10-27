import XCTest

/// Settings › Tools › Skills and plugins against the spike fixture's skills and plugins
/// (`scripts/skills-scenario.ts`). `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a
/// folder) also saves each screenshot there as `skills-<name>.png`. Each test changes the
/// fixture's library, so run them on a fresh fixture.
@MainActor final class SkillsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testAPersonalSkillIsCreatedEditedRelinkedAndDeleted() throws {
        let app = launchIntoSkills()
        screenshot("library")

        app.buttons["skills.new"].tap()
        let name = app.textFields["skill.new.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("research")
        // A name another personal skill holds is refused before Create.
        XCTAssertTrue(element(app, "skill.new.nameProblem").waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["skill.new.create"].isEnabled)
        screenshot("new-taken")
        name.typeText("-notes")
        let description = app.textFields["skill.new.description"]
        description.tap()
        description.typeText("Write release notes from merged pull requests")
        XCTAssertTrue(waitEnabled(app.buttons["skill.new.create"]))
        screenshot("new")
        app.buttons["skill.new.create"].tap()

        // The new skill's page opens once the machine has it.
        let edit = app.buttons["skill.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Write release notes from merged pull requests"].exists)
        screenshot("page")

        edit.tap()
        let field = app.textFields["skill.edit.description"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(", newest first")
        screenshot("edit")
        app.buttons["skill.edit.save"].tap()
        XCTAssertTrue(app.staticTexts["Write release notes from merged pull requests, newest first"].waitForExistence(timeout: 15))

        app.buttons["skill.agents"].tap()
        let claude = app.switches["skill.agent.claude"]
        XCTAssertTrue(claude.waitForExistence(timeout: 10))
        // Codex reads ~/.agents/skills itself, so it stays on and says why.
        XCTAssertFalse(app.switches["skill.agent.codex"].isEnabled)
        screenshot("agents")
        claude.switches.firstMatch.tap()
        app.buttons["skill.agents.done"].tap()
        XCTAssertTrue(app.staticTexts["Codex, OpenCode, Cursor and Pi"].waitForExistence(timeout: 15))

        app.buttons["skill.delete"].tap()
        let confirm = app.sheets.buttons["Delete skill"].firstMatch.exists ? app.sheets.buttons["Delete skill"].firstMatch : app.buttons["Delete skill"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("delete")
        confirm.tap()
        XCTAssertTrue(app.buttons["skills.new"].waitForExistence(timeout: 15))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["skills.row.research-notes"])
        wait(for: [gone], timeout: 15)
        screenshot("deleted")
    }

    func testAPluginIsSwitchedForEachAgentAndAsAWhole() throws {
        let app = launchIntoSkills()
        let row = app.buttons["plugins.row.engineering"]
        for _ in 0..<6 where !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.label.contains("On for Claude Code, Codex and Cursor"))
        row.tap()
        let pi = app.switches["plugin.agent.pi"]
        XCTAssertTrue(pi.waitForExistence(timeout: 10))
        XCTAssertEqual(pi.value as? String, "0")
        screenshot("plugin")
        pi.switches.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["On for Claude Code, Codex, Cursor and Pi"].waitForExistence(timeout: 10))
        app.switches["plugin.enabled"].switches.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Off"].waitForExistence(timeout: 10))
        screenshot("plugin-off")
        app.switches["plugin.enabled"].switches.firstMatch.tap()
        XCTAssertTrue(app.staticTexts["On for Claude Code, Codex, Cursor and Pi"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let updated = expectation(for: NSPredicate(format: "label CONTAINS 'Cursor and Pi'"), evaluatedWith: row)
        wait(for: [updated], timeout: 15)
    }

    private func launchIntoSkills() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        app.openBrowseDestination("library.skills")
        XCTAssertTrue(app.buttons["skills.row.research"].waitForExistence(timeout: 20))
        return app
    }
    private func waitEnabled(_ element: XCUIElement) -> Bool {
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: element)
        return XCTWaiter().wait(for: [enabled], timeout: 10) == .completed
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-skills-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("skills-\(name).png"))
        }
    }
}
