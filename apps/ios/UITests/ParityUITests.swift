import XCTest

@MainActor final class ParityUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTaskEntryIsTheRoundComposeButtonAndOpensTheNativeDraft() {
        let app = launch()
        let start = app.newThreadButton
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        // New thread is the header's round trailing button (the tab bar's prominent one on iOS 27).
        XCTAssertGreaterThan(start.frame.midX, app.frame.midX)
        start.tap()
        XCTAssertTrue(app.navigationBars["New thread"].waitForExistence(timeout: 10))
        capture("start-task")
    }

    func testSearchsPullRequestsPlaceOpensPullRequestsDirectly() {
        let app = launch()
        app.openPulls()
        XCTAssertTrue(app.buttons["Issues"].waitForExistence(timeout: 10))
        // Opened directly: the sheet closes, with no Back to another list.
        XCTAssertFalse(app.navigationBars.buttons["BackButton"].exists)
        app.buttons["settings.close"].tap()
        XCTAssertTrue(app.buttons["search.place.pulls"].waitForExistence(timeout: 10))
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
        XCTAssertTrue(app.buttons["Open a terminal"].waitForExistence(timeout: 10)); app.buttons["Open a terminal"].tap()
        let input = app.textFields["terminal.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let enabled = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: input)
        wait(for: [enabled], timeout: 15)
        input.tap(); input.typeText("pwd\n")
        let output = app.descendants(matching: .any)["terminal.output"]
        wait(for: [expectation(for: NSPredicate(format: "value CONTAINS %@", "/fake"), evaluatedWith: output)], timeout: 15)
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
        // Full screen over the thread, with the page's title, a live page and Copy source.
        let screen = app.descendants(matching: .any)["visualization.screen"]
        XCTAssertTrue(screen.waitForExistence(timeout: 15))
        XCTAssertTrue(app.navigationBars["Interactive counter"].exists)
        XCTAssertTrue(app.webViews["canvas.content"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Couldn't load this visualization"].exists)
        let composer = app.textViews["composer.input"]
        XCTAssertFalse(composer.exists && composer.isHittable, "it covers the thread")
        let copy = app.buttons["visualization.copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10)); copy.tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 5))
        capture("canvas")
        app.buttons["Close"].tap()
        XCTAssertTrue(screen.waitForNonExistence(timeout: 10))
    }
    /// An answer's maths reaches VoiceOver whole and its Mermaid fence draws as a diagram whose
    /// source is a tap away.
    func testAnAnswersMathsAndMermaidDiagramRender() {
        let app = launch()
        app.revealRow("thread.ios-rich-answer").tap()
        let any = app.descendants(matching: .any)
        let prose = any.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "hypotenuse follows", "hypotenuse follows")).firstMatch
        XCTAssertTrue(prose.waitForExistence(timeout: 25))
        // Typeset maths still reads as its TeX to VoiceOver, so the tree can't tell typeset from
        // not; `AnswerMarkdownTests` checks the formulas are drawn. Here: they reach VoiceOver whole.
        let spoken = any.matching(NSPredicate(format: "value CONTAINS %@", "$$c = \\sqrt{a^2 + b^2}$$")).firstMatch
        XCTAssertTrue(spoken.exists, "the display formula reads whole, in its delimiters")
        let diagram = app.images["answer.diagram"]
        XCTAssertTrue(diagram.waitForExistence(timeout: 20), "the Mermaid fence draws as a diagram")
        XCTAssertFalse(any.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Phone --> Daemon", "Phone --> Daemon")).firstMatch.exists,
                       "the drawn diagram replaces its code")
        capture("answer-maths-diagram")
        app.buttons["answer.diagram.source"].tap()
        let source = app.staticTexts["diagram.source"]
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        XCTAssertTrue(source.label.contains("Phone --> Daemon"))
        app.buttons["diagram.copy"].tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 5))
        capture("answer-diagram-source")
        app.buttons["Close"].tap()
        XCTAssertTrue(source.waitForNonExistence(timeout: 10))
    }
    func testPublishedImageOpensAsNativePixels() {
        let app = launch()
        app.revealRow("thread.ios-media").tap()
        let image = app.buttons["Orange fixture image"]
        XCTAssertTrue(image.waitForExistence(timeout: 20)); image.tap()
        XCTAssertTrue(app.images["Orange fixture image"].waitForExistence(timeout: 20))
        capture("image")
    }
    /// The menu leaves before the sheet it picked arrives; a sheet asked for while the menu is
    /// still leaving would never show.
    func testThreadMenuItemsThatOpenASheetOpenIt() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 30)); app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20)); app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.search").tap()
        XCTAssertTrue(app.navigationBars["Search conversation"].waitForExistence(timeout: 10))
        app.closeSheet()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 10)); app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.tools").tap()
        XCTAssertTrue(app.buttons["MCP servers"].waitForExistence(timeout: 10))
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
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 30)); app.openBrowseDestination("library.usage")
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
        let agents = app.buttons["machine.settings.Agents"].firstMatch
        for _ in 0..<6 where !agents.isHittable { app.swipeUp() }
        agents.tap()
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
