import XCTest

/// Real scroll gestures against the fixture's finished 120-turn conversation.
@MainActor final class HistoryPagingUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait }

    func testOlderHistoryLoadsAndReturningToTheEndKeepsHistoryOpen() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-open", "ios-reading", "--perf-probe"]
        app.launch()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "value == 'Ready'"), evaluatedWith: transcript)
        waitForExpectations(timeout: 30)
        for _ in 0..<20 where (app.probeValue("pages.older") ?? 0) < 1 {
            transcript.fling(older: true)
        }
        XCTAssertGreaterThanOrEqual(app.probeValue("pages.older") ?? 0, 1)
        for _ in 0..<60 where (app.probeValue("pages.follow") ?? 0) < 1 {
            transcript.fling(older: false)
        }
        XCTAssertGreaterThanOrEqual(app.probeValue("pages.follow") ?? 0, 1)
        XCTAssertEqual(app.probeValue("pages.live") ?? 0, 0, "Reaching the end must not discard loaded history")
        XCTAssertTrue(transcript.exists)
    }

    func testPagedMessageKeepsItsPositionWhileIdleAndAfterReturningToTheTask() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-open", "ios-reading", "--perf-probe"]
        app.launch()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "value == 'Ready'"), evaluatedWith: transcript)
        waitForExpectations(timeout: 30)
        for _ in 0..<24 where (app.probeValue("pages.older") ?? 0) < 2 {
            transcript.fling(older: true)
        }
        XCTAssertGreaterThanOrEqual(app.probeValue("pages.older") ?? 0, 2)
        // Find a short, fully visible message, so its frame is an actual reading anchor.
        let area = transcript.frame.insetBy(dx: 0, dy: 100)
        let messages = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "message.user.")
        ).allElementsBoundByIndex
        let visible = try XCTUnwrap(messages.first { element in
            let frame = element.frame
            return frame.height > 0 && area.contains(frame) && element.isHittable
        }, "A page must render a visible message, rather than an empty spacer")
        let identifier = visible.identifier
        let y = visible.frame.minY
        for _ in 0..<5 {
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "observe settled layout")], timeout: 0.4)
            XCTAssertTrue(visible.exists)
            XCTAssertEqual(visible.frame.minY, y, accuracy: 2, "Idle remeasurement moved the reading anchor")
        }
        let before = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        before.name = "paged-reading-before-navigation"
        before.lifetime = .keepAlways
        add(before)

        app.navigationBars.buttons.element(boundBy: 0).tap()
        let row = app.buttons["thread.ios-reading"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let restored = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: restored)
        waitForExpectations(timeout: 20)
        XCTAssertEqual(restored.frame.minY, y, accuracy: 2, "Returning to history must restore the same message and pixel offset")
        XCUIDevice.shared.orientation = .landscapeLeft
        expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: restored)
        waitForExpectations(timeout: 10)
        XCUIDevice.shared.orientation = .portrait
        expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: restored)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(restored.frame.minY, y, accuracy: 2, "Returning to the original width must keep the saved reading offset")
        let after = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        after.name = "paged-reading-after-navigation"
        after.lifetime = .keepAlways
        add(after)
    }
}
