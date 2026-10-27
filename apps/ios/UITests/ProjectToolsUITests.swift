import XCTest

/// Project tools on the phone that reach the computer: Open in, Publish repository, Project
/// folders, choosing a GitHub repository to clone, and a thread's Run and preview. Run a fresh
/// fixture first (`ACE_IOS_SPIKE_PORT=9884 bun run spike:daemon`); `TEST_RUNNER_ACE_IOS_SHOTS`
/// keeps each screenshot.
@MainActor final class ProjectToolsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testOpenInListsTheComputersEditorsAndOpensOne() {
        let app = launch()
        openProject(app)
        let openIn = app.buttons["project.openIn"]
        XCTAssertTrue(openIn.waitForExistence(timeout: 10))
        openIn.tap()
        let code = app.buttons["Visual Studio Code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10), "the computer's editors are offered")
        XCTAssertTrue(app.buttons["Show in Finder"].exists)
        shot("project-open-in", app)
        code.tap()
        XCTAssertFalse(app.alerts["Couldn't open it"].waitForExistence(timeout: 3))
    }

    func testPublishingAProjectShowsItsNewRepository() {
        let app = launch()
        openProject(app)
        app.buttons["project.publish"].tap()
        let publish = app.buttons["publish.submit"]
        let shown = publish.waitForExistence(timeout: 20)
        shot("project-publish-opened", app)
        XCTAssertTrue(shown)
        XCTAssertTrue(app.textFields["publish.name"].exists)
        shot("project-publish", app)
        publish.tap()
        XCTAssertTrue(app.staticTexts["publish.phase"].waitForExistence(timeout: 30), "the publication record shows")
        shot("project-published", app)
    }

    func testAllowingAProjectFolderListsIt() {
        let app = launch()
        openProjects(app)
        let folders = app.buttons["projects.folders"]
        for _ in 0..<6 where !folders.isHittable { app.swipeUp() }
        folders.tap()
        let path = app.textFields["folders.path"]
        XCTAssertTrue(path.waitForExistence(timeout: 10))
        shot("project-folders", app)
        path.tap()
        path.typeText("/Users/arpan/code/notes")
        app.buttons["folders.add"].tap()
        XCTAssertTrue(app.staticTexts["/Users/arpan/code/notes"].waitForExistence(timeout: 20))
        shot("project-folders-added", app)
    }

    func testChoosingAGitHubRepositoryFillsTheCloneAddress() {
        let app = launch()
        openProjects(app)
        app.buttons["Add project"].tap()
        let clone = app.buttons["Clone repository"]
        XCTAssertTrue(clone.waitForExistence(timeout: 10))
        clone.tap()
        app.buttons["project.clone.github"].tap()
        let engine = app.buttons["github.repo.ada/engine"]
        XCTAssertTrue(engine.waitForExistence(timeout: 20), "the account's repositories are listed")
        shot("github-repositories", app)
        engine.tap()
        let url = app.textFields["project.clone.url"]
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        XCTAssertEqual(url.value as? String, "https://github.com/ada/engine.git")
        shot("github-clone-filled", app)
    }

    func testRunAndPreviewRunsAScriptAndOffersDevServers() {
        let app = launch()
        let row = app.revealRow("thread.ios-done")
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 25))
        app.buttons["thread.menu"].tap()
        let scripts = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "thread.scripts", "Run and preview…")).firstMatch
        XCTAssertTrue(scripts.waitForExistence(timeout: 10))
        scripts.tap()
        let run = app.buttons["scripts.run.test"]
        XCTAssertTrue(run.waitForExistence(timeout: 20), "the project's scripts are listed")
        XCTAssertTrue(app.buttons["scripts.preview.5173"].waitForExistence(timeout: 10), "detected dev servers are offered")
        shot("run-and-preview", app)
        run.tap()
        XCTAssertTrue(app.navigationBars["Terminal"].waitForExistence(timeout: 20), "the script's terminal opens")
        shot("run-script-terminal", app)
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9884"]
        app.launch()
        return app
    }
    private func openProjects(_ app: XCUIApplication) {
        app.openSettings()
        XCTAssertTrue(app.buttons["library.projects"].waitForExistence(timeout: 10))
        app.buttons["library.projects"].tap()
        XCTAssertTrue(app.buttons["projects.row.ace"].waitForExistence(timeout: 30))
    }
    private func openProject(_ app: XCUIApplication) {
        openProjects(app)
        app.buttons["projects.row.ace"].tap()
        XCTAssertTrue(app.buttons["project.edit"].waitForExistence(timeout: 10))
        shot("project-detail-tools", app)
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
