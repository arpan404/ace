import XCTest

/// Settings › Providers against the spike fixture (`bun run spike:daemon`): a provider's own
/// page, its models, a bad CLI path, and installing a provider that isn't installed, plan first.
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves screenshots.
@MainActor final class ProviderPageUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testProviderPageShowsStatusModelsAndAdvanced() {
        let app = launch()
        defer { app.terminate() }
        let codex = row(app, "Codex")
        XCTAssertTrue(codex.waitForExistence(timeout: 30))
        screenshot("providers-list")
        codex.tap()
        XCTAssertTrue(app.descendants(matching: .any)["provider.status"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["0.161.0 available"].waitForExistence(timeout: 10), "the header says the update")
        XCTAssertTrue(app.descendants(matching: .any)["provider.fix"].firstMatch.exists, "the one fix shows")
        screenshot("codex-top")
        app.swipeUp()
        screenshot("codex-middle")
        app.swipeUp()
        screenshot("codex-advanced")

        let path = app.textFields["provider.path"]
        XCTAssertTrue(path.waitForExistence(timeout: 10))
        path.tap()
        path.typeText("bin/codex\n")
        XCTAssertTrue(app.staticTexts["Enter the full path to the executable, or clear it to find the CLI automatically."].waitForExistence(timeout: 10))
        screenshot("codex-bad-path")

        app.swipeDown(); app.swipeDown()
        let models = app.buttons["provider.models"]
        for _ in 0..<4 where !models.isHittable { app.swipeUp() }
        models.tap()
        XCTAssertTrue(app.navigationBars["Models"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.switches["Hide deprecated models"].waitForExistence(timeout: 10))
        screenshot("codex-models")
        let star = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Star '")).firstMatch
        XCTAssertTrue(star.waitForExistence(timeout: 10))
        let label = star.label.replacingOccurrences(of: "Star ", with: "")
        star.tap()
        XCTAssertTrue(app.buttons["Unstar \(label)"].waitForExistence(timeout: 10), "a star saves and shows")
        app.buttons["Unstar \(label)"].tap()
        XCTAssertTrue(app.buttons["Star \(label)"].waitForExistence(timeout: 10))
    }

    func testInstallingAMissingProviderShowsThePlanThenTheResult() {
        let app = launch()
        defer { app.terminate() }
        let install = app.buttons["provider.install.antigravity"]
        for _ in 0..<4 where !install.isHittable { app.swipeUp() }
        XCTAssertTrue(install.waitForExistence(timeout: 30))
        screenshot("providers-not-installed")
        install.tap()
        let confirm = app.buttons["install.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 20), "the plan shows before anything runs")
        XCTAssertTrue(app.staticTexts["Runs on"].exists)
        screenshot("antigravity-plan")
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Installed"].waitForExistence(timeout: 20))
        screenshot("antigravity-installed")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        app.openBrowseDestination("library.providers")
        return app
    }
    private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-provider-page-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
