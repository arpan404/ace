import XCTest

/// The live browser's degraded sentence, on the spike fixture started with
/// `ACE_IOS_SPIKE_DEGRADED=1`: while the tab's video runs on the processor, the view says so in
/// one plain sentence above the bar, and nothing else.
final class DegradedVideoUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor func testADegradedTabSaysItsVideoRunsOnTheProcessor() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        let row = app.buttons["thread.ios-browser"]
        app.bringToMiddle(row)
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 30))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 20))
        let sentence = app.staticTexts["Video runs on the processor here: this computer has no hardware video encoder."]
        XCTAssertTrue(sentence.waitForExistence(timeout: 20))
        XCTAssertTrue(app.otherElements["browser.degraded"].exists || app.descendants(matching: .any)["browser.degraded"].exists)
        sleep(2)
        screenshot("degraded-browser")
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
