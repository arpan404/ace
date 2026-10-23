import XCTest

/// Reading a long transcript back with an accessibility client attached. UI automation is one: it
/// reads the app's accessibility tree on every query, as VoiceOver and Voice Control do. Against
/// the spike fixture's `ios-reading` thread; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class TranscriptAccessibilityUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    /// A scroll target the feed set earlier (its end, on opening) must not stay standing against
    /// the person's drag: with an accessibility client attached, that pinned the main thread and
    /// the first swipe up never settled.
    func testScrollingUpALongTranscriptStaysResponsiveAndReturnsToItsEnd() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        let row = app.buttons["thread.ios-reading"]
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
            .waitForExistence(timeout: 25))
        for _ in 0..<10 where !(row.exists && row.isHittable) { app.swipeUp() }
        row.tap()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 25))
        // The last turn, which a restart interrupted, is in view at the end.
        let last = message("Keep the relay cursor for step 120 too.", in: app)
        XCTAssertTrue(last.waitForExistence(timeout: 25))
        var slowest: TimeInterval = 0
        for _ in 0..<12 {
            let started = Date()
            transcript.swipeDown(velocity: .fast)
            slowest = max(slowest, Date().timeIntervalSince(started))
            // A settled swipe takes about three seconds, its fling included; a pinned main thread
            // never lets the app go idle, so the swipe waits a minute and more.
            XCTAssertLessThan(slowest, 15, "a swipe up didn't settle")
        }
        XCTAssertFalse(last.exists && last.isHittable, "the swipes up never left the end")
        let latest = app.buttons["transcript.latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        // Back at the end, with the rows measured on the way there.
        let shown = NSPredicate(format: "exists == true AND hittable == true")
        expectation(for: shown, evaluatedWith: last)
        waitForExpectations(timeout: 15)
    }
    private func message(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
    }
}
