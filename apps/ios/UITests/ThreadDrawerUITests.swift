import XCTest

/// A compact window's list as a drawer over the open thread, against the spike fixture: the
/// thread's sidebar button brings the list out from the leading edge and pushes the thread
/// aside, a row picked there opens in its place, and the dimmed thread closes the list. Run on a
/// fresh fixture, `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selecting its port; `ACE_IOS_SHOTS` (a
/// folder) also saves each screenshot there.
@MainActor final class ThreadDrawerUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheSidebarButtonBringsTheListOverTheThreadAndAPickedRowOpensInItsPlace() throws {
        let app = try launch()
        let width = app.windows.firstMatch.frame.width
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        let next = app.buttons["thread.ios-question"]
        XCTAssertFalse(next.reachable, "the thread fills the window")
        XCTAssertFalse(app.tabBars.buttons["Pulls"].reachable)
        screenshot("drawer-closed")

        let sidebar = app.buttons["thread.sidebar"]
        XCTAssertTrue(sidebar.waitForHittable(timeout: 10))
        sidebar.tap()
        XCTAssertTrue(next.waitForHittable(timeout: 10), "the list is out over the thread")
        // The thread is pushed aside, still in sight at the trailing edge as one close button.
        let closer = app.buttons["drawer.close"]
        XCTAssertTrue(closer.waitForExistence(timeout: 5))
        screenshot("drawer-open")
        XCTAssertGreaterThan(closer.frame.minX, width * 0.7)
        XCTAssertLessThan(closer.frame.minX, width * 0.9)
        // The list carries Threads, Pull requests and New thread while the tab bar is away.
        XCTAssertTrue(app.buttons["sidebar.threads"].reachable)
        XCTAssertTrue(app.buttons["inbox.compose"].reachable)
        XCTAssertTrue(app.buttons["thread.ios-form"].isSelected)

        next.tap()
        XCTAssertTrue(title("Clean up the release notes", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(closer.waitForNonExistence(timeout: 10), "picking a row closes the drawer")
        XCTAssertTrue(next.waitForNotHittable(timeout: 10))
        screenshot("drawer-picked")

        sidebar.tap()
        XCTAssertTrue(closer.waitForExistence(timeout: 10))
        XCTAssertTrue(next.isSelected)
        closer.tap()
        XCTAssertTrue(closer.waitForNonExistence(timeout: 10), "the dimmed thread closes the drawer")
        XCTAssertTrue(title("Clean up the release notes", in: app).exists)
        XCTAssertTrue(sidebar.waitForHittable(timeout: 10))
        XCTAssertLessThan(sidebar.frame.minX, width * 0.2, "the thread is back in its place")
    }

    func testASwipeFromTheLeadingEdgeOpensTheDrawerAndASwipeOnTheThreadClosesIt() throws {
        let app = try launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        let next = app.buttons["thread.ios-question"]
        let window = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
        let frame = app.windows.firstMatch.frame
        window.withOffset(CGVector(dx: 1, dy: frame.height * 0.45))
            .press(forDuration: 0.05, thenDragTo: window.withOffset(CGVector(dx: frame.width * 0.7, dy: frame.height * 0.45)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(next.waitForHittable(timeout: 10), "the edge swipe brings the list out")
        let closer = app.buttons["drawer.close"]
        XCTAssertTrue(closer.waitForExistence(timeout: 5))
        let start = closer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -frame.width * 0.6, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(closer.waitForNonExistence(timeout: 10), "swiping the thread back closes the drawer")
        XCTAssertTrue(next.waitForNotHittable(timeout: 10))
    }

    func testAPageOverTheThreadGoesBackWithTheChevronAndOnlyTheThreadOpensTheDrawer() throws {
        let app = try launch()
        open("thread.ios-browser", in: app)
        XCTAssertTrue(title("Check the checkout flow", in: app).waitForExistence(timeout: 20))
        let sidebar = app.buttons["thread.sidebar"]
        XCTAssertTrue(sidebar.waitForHittable(timeout: 10))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 15))
        XCTAssertFalse(sidebar.reachable, "a pushed page has the Back chevron")
        screenshot("drawer-pushed-page")
        app.navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label BEGINSWITH 'Check the checkout flow'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(sidebar.waitForHittable(timeout: 10), "back on the thread, its sidebar button is back")
    }

    private func launch() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("a compact phone window") }
        return app
    }
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons[id]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
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

private extension XCUIElement {
    var reachable: Bool { exists && isHittable }
    func waitForHittable(timeout: TimeInterval) -> Bool { settles(timeout) { $0.reachable } }
    func waitForNotHittable(timeout: TimeInterval) -> Bool { settles(timeout) { !$0.reachable } }
    private func settles(_ timeout: TimeInterval, _ condition: (XCUIElement) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition(self) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition(self)
    }
}
