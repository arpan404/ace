import XCTest

/// Inbox scrolling while threads keep changing status, for the record in the test log: start the
/// fixture with `ACE_IOS_SPIKE_INBOX=300` (and `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for its port).
/// Spends no provider quota.
@MainActor final class InboxScrollUITests: XCTestCase {
    func testScrollTheBusyInboxWhileRowsChange() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        let busy = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.ios-busy-")).firstMatch
        XCTAssertTrue(busy.waitForExistence(timeout: 30), "Start the fixture with ACE_IOS_SPIKE_INBOX=300")
        let list = app.collectionViews.firstMatch
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            list.swipeUp(velocity: .fast)
            list.swipeUp(velocity: .fast)
            list.swipeDown(velocity: .fast)
            list.swipeDown(velocity: .fast)
        }
    }
}
