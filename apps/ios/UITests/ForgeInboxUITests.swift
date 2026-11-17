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
        let segments = ["forge.kind.pulls", "forge.kind.issues", "forge.kind.inbox"].map { app.buttons[$0] }
        XCTAssertTrue(segments[2].waitForExistence(timeout: 20))
        let width = app.windows.firstMatch.frame.width
        for segment in segments {
            XCTAssertTrue(segment.isHittable)
            XCTAssertGreaterThanOrEqual(segment.frame.minX, 0)
            XCTAssertLessThanOrEqual(segment.frame.maxX, width)
            // Wide enough for its whole name: a cut-short "Iss…" is narrower than the word at a
            // small 13 pt, so this holds the switch to showing every name in full.
            let name = segment.label as NSString
            let word = name.size(withAttributes: [.font: UIFont.systemFont(ofSize: 13)]).width
            XCTAssertGreaterThanOrEqual(segment.frame.width, word.rounded(.up), "\(segment.label) is cut short")
        }
        // New pull request stays on the page, clear of the switch.
        let new = app.buttons["forge.newpr"]
        XCTAssertTrue(new.waitForExistence(timeout: 10))
        XCTAssertTrue(new.isHittable)
        XCTAssertFalse(new.frame.intersects(segments[2].frame))
        screenshot("switch")
    }

    func testThePullsSwitchAtTheLargestTextStillOffersEveryList() {
        let app = launchOnPulls(extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let inbox = app.buttons["forge.kind.inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["forge.newpr"].waitForExistence(timeout: 10))
        screenshot("switch-largest-text")
        if !inbox.isHittable { app.buttons["forge.kind.pulls"].swipeLeft() }
        inbox.tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
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
