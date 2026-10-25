import XCTest

/// GitHub notifications on the Pulls tab, on the spike fixture (`bun run spike:daemon`).
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves screenshots.
@MainActor final class ForgeInboxUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testANotificationOpensItsPullRequestFromAnotherRepository() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        app.tabBars.buttons["Pulls"].firstMatch.tap()
        let segment = app.segmentedControls["forge.kind"].buttons["Inbox"]
        XCTAssertTrue(segment.waitForExistence(timeout: 20))
        segment.tap()
        let row = app.buttons["forge.inbox.9002"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        screenshot("inbox")
        row.tap()
        // #31 lives in acme/docs-site, not the project's repository.
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Rewrite the install page for the daemon"].exists)
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
