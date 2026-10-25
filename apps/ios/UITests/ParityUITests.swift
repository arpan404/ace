import XCTest

@MainActor final class ParityUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTaskEntryIsTheBottomToolbarComposeButtonAndOpensTheNativeDraft() {
        let app = launch()
        let start = app.newThreadButton
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        let filter = app.buttons["inbox.projects"]
        XCTAssertTrue(filter.exists)
        // The project chip sits under the header; New thread is the tab bar's round trailing button.
        XCTAssertLessThan(filter.frame.maxY, app.frame.midY)
        XCTAssertGreaterThan(start.frame.minY, app.frame.midY)
        XCTAssertGreaterThan(start.frame.midX, app.frame.midX)
        start.tap()
        XCTAssertTrue(app.navigationBars["New thread"].waitForExistence(timeout: 10))
        capture("start-task")
    }

    func testCanonicalApprovalLabelsAndKeyboardKeepComposerVisible() {
        let app = launch()
        let row = app.buttons["thread.ios-approval"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.buttons["approval.allow_once"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.buttons["approval.allow_once"].label, "Allow once")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Always allow")).firstMatch.exists)
        let input = app.textViews["composer.input"]
        input.tap()
        input.typeText((1...12).map { "Line \($0)" }.joined(separator: "\n"))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY)
        XCTAssertTrue(app.buttons["composer.send"].isHittable)
        capture("approval-keyboard")
    }

    func testDarkInboxAndThread() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 30))
        capture("inbox")
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_once"].waitForExistence(timeout: 30))
        capture("approval")
    }

    func testNativeTerminalSendsInputAndReceivesOutput() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 30))
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        let terminal = app.threadMenuItem("thread.terminal")
        XCTAssertTrue(terminal.waitForExistence(timeout: 20)); terminal.tap()
        XCTAssertTrue(app.buttons["New"].waitForExistence(timeout: 10)); app.buttons["New"].tap()
        let input = app.textFields["terminal.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let enabled = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: input)
        wait(for: [enabled], timeout: 15)
        input.tap(); input.typeText("pwd\n")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/fake")).firstMatch.waitForExistence(timeout: 15))
        capture("terminal")
    }

    func testPublishedCanvasDrawsInlineAndOpensFullScreenInTheNativeSandbox() {
        let app = launch()
        app.revealRow("thread.ios-media").tap()
        // The page draws inline in the transcript, in a sandboxed frame XCUITest can't see into;
        // it's checked as a loaded web view, then opened full screen, not a refusal.
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 25))
        let full = app.buttons["Open Interactive counter full screen"]
        XCTAssertTrue(full.waitForExistence(timeout: 20)); full.tap()
        sleep(2)
        XCTAssertFalse(app.staticTexts["Couldn't open media"].exists)
        capture("canvas")
    }
    func testPublishedImageOpensAsNativePixels() {
        let app = launch()
        app.revealRow("thread.ios-media").tap()
        let image = app.buttons["Orange fixture image"]
        XCTAssertTrue(image.waitForExistence(timeout: 20)); image.tap()
        XCTAssertTrue(app.images["Orange fixture image"].waitForExistence(timeout: 20))
        capture("image")
    }
    func testThreadMcpControlsUpdateCanonicalServerState() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 30)); app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20)); app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.tools").tap()
        XCTAssertTrue(app.buttons["MCP servers"].waitForExistence(timeout: 10)); app.buttons["MCP servers"].tap()
        XCTAssertTrue(app.staticTexts["Project tools"].waitForExistence(timeout: 20))
        let toggle = app.buttons["mcp.toggle.Project tools"]
        let next = toggle.label == "Enable" ? "Disable" : "Enable"
        toggle.tap()
        let changed = expectation(for: NSPredicate(format: "label == %@", next), evaluatedWith: toggle)
        wait(for: [changed], timeout: 15)
        capture("mcp")
    }

    func testMachineSettingsAndUsageLoadThroughTheSharedSdk() {
        let app = launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 30)); app.openBrowseDestination("library.usage")
        XCTAssertTrue(app.buttons["Tokens"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["62% left"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["service.problem"].exists)
        app.buttons["Tokens"].tap()
        XCTAssertTrue(app.staticTexts["Input tokens"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["Limits"].tap()
        XCTAssertTrue(app.staticTexts["62% left"].waitForExistence(timeout: 20))
        capture("usage")
        app.navigationBars.buttons["BackButton"].firstMatch.tap()
        app.openBrowseDestination("settings.machines")
        app.buttons["machines.row.ios-spike-host"].tap()
        // The tab bar keeps its own Threads tab: scope the row to the pushed list.
        for _ in 0..<6 where !app.collectionViews.buttons["Threads"].isHittable { app.swipeUp() }
        app.collectionViews.buttons["Threads"].tap()
        XCTAssertTrue(app.switches["setting.threads.forkOnSwitch"].waitForExistence(timeout: 15))
        capture("machine-settings")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "parity-\(name)"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
