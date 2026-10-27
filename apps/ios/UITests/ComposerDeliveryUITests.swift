import XCTest

/// The composer's round button against the spike fixture's working `ios-agents` thread
/// (`TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port).
@MainActor final class ComposerDeliveryUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testATypedMessageWhileTheAgentWorksShowsSteerOrQueueNotSend() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        let row = app.buttons["thread.ios-agents"]
        for _ in 0..<12 where !row.isHittable { app.swipeUp() }
        row.tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 20))
        input.tap()
        input.typeText("Then update the docs")
        let send = app.buttons["composer.send"]
        let glyph = send.images.firstMatch
        XCTAssertTrue(glyph.waitForExistence(timeout: 10))
        let label = send.label
        // The bridge says how a follow-up goes; the glyph says it in the web's terms.
        let expected = label == "Steer the running turn" ? "ph-arrow-bend-up-right-bold" : "ph-queue-bold"
        XCTAssertNotEqual(label, "Send message", "the agent is working, so the message steers or queues")
        XCTAssertEqual(glyph.label, expected)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "ios-composer-delivery-glyph"
        shot.lifetime = .keepAlways
        add(shot)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("composer-delivery.png"))
        }
    }
}
