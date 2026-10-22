import XCTest

/// A streaming answer on the fixture's `ios-stream` thread. Run on a fixture whose
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` gives its port.
@MainActor final class StreamingUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheFeedFollowsAStreamingAnswerToItsEnd() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 25))
        let row = app.buttons["thread.ios-stream"]
        for _ in 0..<8 where !(row.exists && row.isHittable) { app.swipeUp(velocity: .slow) }
        row.tap()
        XCTAssertTrue(pieces(in: app).firstMatch.waitForExistence(timeout: 25))
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        sleep(2)
        let before = newest(in: app)
        sleep(4)
        let after = newest(in: app)
        // About 80 deltas arrived; the newest words are the ones in view, just above the composer.
        XCTAssertGreaterThan(after.step, before.step + 20, "the answer keeps streaming in view")
        XCTAssertLessThanOrEqual(after.frame.maxY, input.frame.minY, "the newest line sits above the composer")
        XCTAssertGreaterThan(after.frame.maxY, input.frame.minY - 400, "the feed is at the answer's end")
        XCTAssertFalse(app.buttons["transcript.latest"].exists, "Scroll to end shows while following the end")
    }

    private func pieces(in app: XCUIApplication) -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'message.answer.' AND label CONTAINS 'Next step'"))
    }
    /// The highest step number in the streaming answer's last drawn piece, and where that piece is.
    private func newest(in app: XCUIApplication) -> (step: Int, frame: CGRect) {
        let pieces = pieces(in: app)
        // One snapshot, so rows changing between reads can't shift the indices.
        guard let last = pieces.allElementsBoundByIndex.last else { return (0, .zero) }
        let steps = last.label.components(separatedBy: "Next step ").dropFirst().compactMap { Int($0.prefix { $0.isNumber }) }
        return (steps.max() ?? 0, last.frame)
    }
}
