import XCTest

/// The thread's terminal against the fixture shell (`packages/fake-daemon` terminal programs):
/// a colour chart, a full-screen program driven by keys, a fast flood of output with Find, and
/// ending the session. `ACE_IOS_SHOTS` (a folder) keeps each screen as a PNG.
@MainActor final class TerminalUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTerminalDrawsColoursFullScreenProgramsAndFindsInFastOutput() {
        let app = launch()
        open(app)
        let output = app.descendants(matching: .any)["terminal.output"]
        XCTAssertTrue(output.waitForExistence(timeout: 15))
        let input = app.textFields["terminal.input"]
        wait(for: [expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: input)], timeout: 15)
        input.tap()
        input.typeText("colors\n")
        XCTAssertTrue(screen(output, contains: "inverse"))
        capture("colours")

        input.typeText("top\n")
        sleep(1); capture("top-1s")
        sleep(2); capture("top-3s")
        let top = screen(output, contains: "PID")
        capture("top")
        XCTAssertTrue(top, "top drew: \(output.value ?? "")")
        input.typeText("jj")
        XCTAssertTrue(screen(output, contains: "977"))
        capture("top-moved")
        input.typeText("q")
        XCTAssertTrue(screen(output, contains: "inverse"), "leaving top brings the shell's screen back")

        input.typeText("flood 3000\n")
        XCTAssertTrue(screen(output, contains: "module-3000.ts"))
        capture("flood")

        app.buttons["terminal.find"].tap()
        let field = app.textFields["terminal.find.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("module-2990.ts")
        let count = app.staticTexts["terminal.find.count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        wait(for: [expectation(for: NSPredicate(format: "label == '1 of 1'"), evaluatedWith: count)], timeout: 10)
        capture("find")
        app.buttons["terminal.find.done"].tap()

        app.buttons["terminal.more"].tap()
        XCTAssertTrue(app.buttons["End session"].waitForExistence(timeout: 5))
        capture("menu")
        app.buttons["End session"].tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'End session'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        capture("end-confirm")
        confirm.tap()
        XCTAssertTrue(app.buttons["Open a terminal"].waitForExistence(timeout: 10))
        capture("empty")
    }

    // MARK: Helpers

    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 30))
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        let terminal = app.threadMenuItem("thread.terminal")
        XCTAssertTrue(terminal.waitForExistence(timeout: 20)); terminal.tap()
        let start = app.buttons["Open a terminal"]
        if start.waitForExistence(timeout: 10) { start.tap() }
    }
    /// The surface's accessibility value is the text on screen.
    private func screen(_ output: XCUIElement, contains text: String) -> Bool {
        let shown = expectation(for: NSPredicate(format: "value CONTAINS %@", text), evaluatedWith: output)
        return XCTWaiter.wait(for: [shown], timeout: 15) == .completed
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "terminal-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("terminal-\(name).png"))
        }
    }
}
