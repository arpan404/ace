import XCTest

/// A thread's pages and bar on a phone: the system's title with the project and model under it
/// keeps the bar's width up to ⋯; Chat and Changes are a swipe apart and in ⋯ (the page not
/// showing leads it) when the thread has changes; Files, Terminal, Browser and Agents push from
/// ⋯. Run on a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port,
/// `TEST_RUNNER_ACE_IOS_APPEARANCE` light or dark (dark by default) and `TEST_RUNNER_ACE_IOS_SHOTS`
/// a folder for the screenshots.
@MainActor final class ThreadPagesUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testChatAndChangesSwitchFromTheMenuAndTheTitleKeepsTheBar() {
        let app = launch(into: "thread.ios-changes")
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 25))
        XCTAssertTrue(menu.isHittable, "⋯ is in the bar, never folded into More")
        let title = app.threadTitle()
        XCTAssertLessThan(title.frame.maxX, menu.frame.minX + 1, "the title stops before ⋯")
        XCTAssertTrue(app.navigationBars.staticTexts.matching(NSPredicate(format: "label CONTAINS 'ace-next'")).firstMatch.exists,
                      "the line under the title names the project")
        shot("changes-chat")

        menu.tap()
        let changes = app.threadMenuItem("thread.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10), "⋯ leads with Changes")
        XCTAssertTrue(changes.label.contains("files"), "Changes reads its file count: \(changes.label)")
        XCTAssertFalse(app.buttons["thread.chat"].exists, "Chat is showing, so ⋯ doesn't offer it")
        XCTAssertTrue(app.threadMenuItem("thread.files").exists && app.threadMenuItem("thread.terminal").exists
                      && app.threadMenuItem("thread.browser").exists && app.threadMenuItem("thread.agents").exists,
                      "the thread's screens are in ⋯'s first row")
        shot("changes-menu")
        changes.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.page.changes.body"].waitForExistence(timeout: 10), "Changes shows its page")
        shot("changes-changes")
        app.showThreadPage("chat")
        XCTAssertTrue(app.scrollViews["transcript"].waitForExistence(timeout: 10), "Chat comes back")

        // Files pushes over the thread; back returns to it.
        menu.tap()
        let files = app.threadMenuItem("thread.files")
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 10), "Files is pushed")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
    }

    func testALongProjectNameStaysUnderTheTitleBesideTheMenu() {
        let app = launch(opening: "ios-long-project", extra: [])
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 25))
        let title = app.threadTitle()
        XCTAssertLessThan(title.frame.maxX, menu.frame.minX + 1, "the title stops before ⋯")
        XCTAssertGreaterThan(title.frame.width, app.frame.width / 2, "the title has most of the bar")
        XCTAssertTrue(app.navigationBars.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'billing-reconciliation-service'")).firstMatch.exists,
                      "the line under the title leads with the project")
        shot("long-chat")
        title.tap()
        XCTAssertTrue(app.titleMenuItem("thread.title.model", label: "Model").waitForExistence(timeout: 10), "the title opens its menu")
        shot("long-title-menu")
    }

    func testAtAccessibilityTextTheMenuStaysInTheBarAndOffersChanges() {
        // Opened at launch: at this size the inbox row is too far down to reveal reliably.
        let app = launch(opening: "ios-changes",
                         extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 25), "the thread opens with ⋯ in its bar")
        XCTAssertTrue(menu.isHittable, "⋯ is in the bar, never folded into More")
        shot("large-chat")
        menu.tap()
        let changes = app.threadMenuItem("thread.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10), "⋯ offers Changes")
        shot("large-menu")
        changes.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.page.changes.body"].waitForExistence(timeout: 10), "Changes shows its page")
        XCTAssertTrue(menu.waitForExistence(timeout: 10) && menu.isHittable, "⋯ stays in the bar over Changes")
    }

    func testAThreadWithoutChangesOffersNoPageAndPushesItsScreens() {
        let app = launch(into: "thread.ios-done")
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 25))
        shot("done-chat")
        menu.tap()
        let agents = app.threadMenuItem("thread.agents")
        XCTAssertTrue(agents.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["thread.changes"].exists || app.buttons["thread.chat"].exists, "nothing to switch to")
        shot("done-menu")
        agents.tap()
        XCTAssertTrue(app.descendants(matching: .any)["agents.page"].waitForExistence(timeout: 10), "Agents is pushed")
        XCTAssertTrue(app.navigationBars["Agents"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "back returns to the thread")
    }

    private var appearance: String { ProcessInfo.processInfo.environment["ACE_IOS_APPEARANCE"] ?? "dark" }

    private func launch(into row: String) -> XCUIApplication {
        let app = start([])
        app.revealRow(row).tap()
        return app
    }

    /// Opens the thread `id` at launch (`--spike-open`), without going through the inbox.
    private func launch(opening id: String, extra: [String]) -> XCUIApplication {
        start(["--spike-open", id] + extra)
    }

    private func start(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "-ace.appearance", appearance] + extra
        app.launchWithArguments()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch.tap()
        }
        return app
    }

    private func shot(_ name: String) {
        let screen = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screen)
        attachment.name = "pages-\(name)-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? screen.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(appearance).png"))
        }
    }
}
