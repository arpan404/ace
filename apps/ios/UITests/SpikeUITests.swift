import XCTest

@MainActor final class SpikeUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    func testInboxThreadAndApprovalScreens() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 25))
        screenshot("inbox")
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.otherElements["approval.card"].waitForExistence(timeout: 10))
        screenshot("approval")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["thread.ios-stream"].tap()
        XCTAssertTrue(app.staticTexts["spike.loaded"].waitForExistence(timeout: 25))
        let loaded = NSPredicate(format: "label CONTAINS '2000 items'")
        expectation(for: loaded, evaluatedWith: app.staticTexts["spike.loaded"])
        waitForExpectations(timeout: 25)
        screenshot("thread")
    }
    func testScrollWhileTwoThousandItemsStream() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        let loaded = NSPredicate(format: "label CONTAINS '2000 items'")
        expectation(for: loaded, evaluatedWith: app.staticTexts["spike.loaded"])
        waitForExpectations(timeout: 25)
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTMemoryMetric(application: app)], options: options) {
            app.collectionViews.firstMatch.swipeDown(velocity: .fast)
            app.collectionViews.firstMatch.swipeDown(velocity: .fast)
            app.collectionViews.firstMatch.swipeUp(velocity: .fast)
        }
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike"]
        app.launch()
        return app
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
