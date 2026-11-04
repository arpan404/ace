import XCTest

/// Compact navigation uses full-screen lists and the system back stack.
@MainActor final class ThreadDrawerUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testBackReturnsToTheTaskListAndAnotherTaskCanOpen() throws {
        let app = try launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["thread.sidebar"].exists)
        // A thread page has no tab bar.
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Threads"].isHittable)
        back(in: app)
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.firstMatch.buttons["Threads"].waitForExistence(timeout: 10))
        open("thread.ios-question", in: app)
        XCTAssertTrue(title("Clean up the release notes", in: app).waitForExistence(timeout: 20))
        back(in: app)
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 10))
        screenshot("task-list-after-back")
    }

    func testPullRequestBackReturnsToThePullList() throws {
        let app = try launch()
        app.openPulls()
        let row = app.buttons["forge.pull.245"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["thread.sidebar"].exists)
        back(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        screenshot("pull-list-after-back")
    }

    private func back(in app: XCUIApplication) {
        let button = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
    }

    private func launch(probe: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
            + (probe ? ["--perf-probe"] : [])
        app.launch()
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("a compact phone window") }
        return app
    }
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons[id]
        // The fixture's list is longer than a screen: scroll until the row is drawn.
        _ = app.inboxReady.waitForExistence(timeout: 30)
        for _ in 0..<8 where !(row.exists && row.isHittable) { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }
    private func title(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "thread.title").matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }
    private func screenshot(_ name: String) {
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
