import XCTest

/// GitHub notifications on the Pulls tab, on the spike fixture (`bun run spike:daemon`).
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves screenshots.
@MainActor final class ForgeInboxUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testANotificationOpensItsPullRequestFromAnotherRepository() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 25))
        app.openPulls()
        // The list's large title names it: Pulls, then Issues.
        XCTAssertTrue(app.navigationBars["Pulls"].waitForExistence(timeout: 20))
        app.buttons["forge.kind.issues"].tap()
        XCTAssertTrue(app.navigationBars["Issues"].waitForExistence(timeout: 10))
        let segment = app.buttons["forge.kind.inbox"]
        XCTAssertTrue(segment.waitForExistence(timeout: 20))
        segment.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        let row = app.buttons["forge.inbox.9002"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        screenshot("inbox")
        row.tap()
        // #31 lives in acme/docs-site, not the project's repository.
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Rewrite the install page for the daemon"].exists)
    }

    func testThePullsSwitchKeepsEveryListsNameOnThePage() {
        let app = launchOnPulls()
        assertEveryListNamedWhole(app)
        screenshot("switch")
        assertTheActionsOpen(app)
    }

    func testThePullsSwitchAtTheLargestTextStillOffersEveryList() {
        let app = launchOnPulls(extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        assertEveryListNamedWhole(app)
        screenshot("switch-largest-text")
        assertTheActionsOpen(app)
        let inbox = app.buttons["forge.kind.inbox"]
        reveal(inbox, along: app.buttons["forge.kind.pulls"])
        inbox.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
    }

    /// Each list's name in the switch shows whole, not cut to an ellipsis: the segment says
    /// "whole" or "cut" from its words' width against their whole width (debug builds).
    private func assertEveryListNamedWhole(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for id in ["forge.kind.pulls", "forge.kind.issues", "forge.kind.inbox"] {
            let segment = app.buttons[id]
            XCTAssertTrue(segment.waitForExistence(timeout: 20), id, file: file, line: line)
            XCTAssertEqual(segment.value as? String, "whole", "\(id) is cut short", file: file, line: line)
        }
    }

    /// New pull request opens its sheet and the state filter its menu, scrolled to where needed.
    private func assertTheActionsOpen(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let new = app.buttons["forge.newpr"]
        XCTAssertTrue(new.waitForExistence(timeout: 10), file: file, line: line)
        reveal(new, along: new)
        new.tap()
        XCTAssertTrue(app.buttons["forge.newpr.head"].waitForExistence(timeout: 20), file: file, line: line)
        app.buttons["Cancel"].tap()
        let filters = app.buttons["forge.filters"]
        XCTAssertTrue(filters.waitForExistence(timeout: 10), file: file, line: line)
        reveal(filters, along: new)
        filters.tap()
        let merged = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Merged'")).firstMatch
        XCTAssertTrue(merged.waitForExistence(timeout: 10), file: file, line: line)
        merged.tap()
        XCTAssertTrue(filters.label.contains("Merged"), filters.label, file: file, line: line)
    }

    /// Scrolls a sideways row until `element` can take a tap, swiping on `row`.
    private func reveal(_ element: XCUIElement, along row: XCUIElement) {
        for _ in 0..<4 where !element.isHittable { row.swipeLeft() }
    }

    private func launchOnPulls(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"] + extra
        app.launchWithArguments()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 25))
        app.openPulls()
        XCTAssertTrue(app.navigationBars["Pulls"].waitForExistence(timeout: 20))
        return app
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-forge-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("forge-\(name).png"))
        }
    }
}
