import XCTest

/// Managing a project from the phone, as the web does: edit its name, icon, defaults and notes,
/// and remove it from ace keeping its folder. Run a fresh fixture first
/// (`ACE_IOS_SPIKE_PORT=9884 bun run spike:daemon`); `TEST_RUNNER_ACE_IOS_SPIKE_PORT` picks its
/// port and `TEST_RUNNER_ACE_IOS_SHOTS` a folder that keeps each screenshot.
@MainActor final class ProjectManageUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testEditingAProjectRenamesItAndKeepsItsNotesOnTheMachine() {
        let app = launch()
        openProject("ace", in: app)
        XCTAssertTrue(app.staticTexts["Notes"].waitForExistence(timeout: 10))
        shot("project-detail", app)

        app.buttons["project.edit"].tap()
        let name = app.textFields["project.edit.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["project.edit.model"].waitForExistence(timeout: 20), "the project's choices load")
        shot("project-edit", app)

        name.tap()
        name.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        name.typeText("ace-mobile")
        app.segmentedControls["project.edit.iconMode"].buttons["Icon"].tap()
        XCTAssertTrue(app.buttons["Rocket"].waitForExistence(timeout: 5))
        app.buttons["Rocket"].tap()
        shot("project-edit-icon", app)

        for _ in 0..<6 where !app.buttons["project.edit.addNote"].isHittable { app.swipeUp() }
        app.buttons["project.edit.addNote"].tap()
        let note = app.textFields["Note"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        note.tap()
        note.typeText("Tests use bun run test, never bun test")
        shot("project-edit-notes", app)
        app.buttons["project.edit.save"].tap()

        XCTAssertTrue(app.navigationBars["ace-mobile"].waitForExistence(timeout: 20), "the rename shows once the machine took it")
        XCTAssertTrue(app.staticTexts["Tests use bun run test, never bun test"].waitForExistence(timeout: 10))
        shot("project-detail-saved", app)
    }

    func testRemovingAProjectWithRunningThreadsOffersToStopThem() {
        let app = launch()
        openProject("ace", in: app)
        for _ in 0..<6 where !app.buttons["project.remove"].isHittable { app.swipeUp() }
        app.buttons["project.remove"].tap()
        XCTAssertTrue(app.buttons["project.remove.confirm"].waitForExistence(timeout: 5))
        shot("project-remove-confirm", app)
        app.buttons["project.remove.confirm"].firstMatch.tap()
        // The fixture's project has a thread that never stops working.
        XCTAssertTrue(app.buttons["project.remove.stop"].firstMatch.waitForExistence(timeout: 20))
        shot("project-remove-running", app)
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9884"]
        app.launch()
        return app
    }
    private func openProject(_ id: String, in app: XCUIApplication) {
        app.openSettings()
        XCTAssertTrue(app.buttons["library.projects"].waitForExistence(timeout: 10))
        app.buttons["library.projects"].tap()
        let row = app.buttons["projects.row.\(id)"]
        let found = row.waitForExistence(timeout: 30)
        shot("projects", app)
        XCTAssertTrue(found, "the machine lists project \(id)")
        row.tap()
        XCTAssertTrue(app.buttons["project.edit"].waitForExistence(timeout: 10))
    }
    private func shot(_ name: String, _ app: XCUIApplication) {
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
