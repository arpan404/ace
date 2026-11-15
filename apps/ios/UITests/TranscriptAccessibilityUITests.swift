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
        app.launchWithArguments()
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
    /// Finished turns whose work logs list edited files lay out chips in every log row: swiping
    /// through them with an accessibility client attached must stay responsive too. The fixture's
    /// `ios-log-long` thread has six finished turns, each an ask ("Keep relay cursors, part N."),
    /// one "Worked for" log and an answer.
    func testSwipingThroughFinishedWorkLogsStaysResponsive() {
        let app = XCUIApplication()
        // `--perf-log` logs the feed's layout counts each second under `dev.ace.perf`
        // (`PerfCounters`), so a hang shows which work never stops; `--perf-probe` hands the
        // totals to this test, attached below.
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--perf-probe", "--perf-log"]
        app.launchWithArguments()
        // Attached however the test ends, a hang or a failed wait included.
        addTeardownBlock { @MainActor in
            let counts = XCTAttachment(string: app.descendants(matching: .any)["perf.probe"].value as? String ?? "")
            counts.name = "perf counts"
            counts.lifetime = .keepAlways
            self.add(counts)
        }
        app.revealRow("thread.ios-log-long").tap()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 25))
        // A finished log is on screen before any swipe: an empty transcript or one stuck on its
        // placeholder fails here, not on the timing. The feed opens at its end, so the earlier
        // turns' logs are above the screen: any hittable one counts.
        let logs = app.buttons.matching(identifier: "work.toggle")
        let deadline = Date(timeIntervalSinceNow: 25)
        while !logs.allElementsBoundByIndex.contains(where: { $0.isHittable }), Date() < deadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.5))
        }
        XCTAssertTrue(logs.allElementsBoundByIndex.contains { $0.isHittable }, "no finished log on screen")
        XCTAssertTrue(message("Keep relay cursors, part 6.", in: app).exists, "the last turn isn't the one open")
        var slowest: TimeInterval = 0
        var earlier = false
        for direction in [false, false, false, false, true, true, true, true] {
            let started = Date()
            if direction { transcript.swipeUp(velocity: .fast) } else { transcript.swipeDown(velocity: .fast) }
            slowest = max(slowest, Date().timeIntervalSince(started))
            // Back through the history, an earlier turn's finished log comes on screen.
            if !direction, !earlier {
                earlier = (1...5).contains { message("Keep relay cursors, part \($0).", in: app).exists }
                    && logs.allElementsBoundByIndex.contains { $0.isHittable }
            }
        }
        XCTAssertTrue(earlier, "the swipes up never showed an earlier turn's finished log")
        // A settled swipe takes about three seconds, its fling included.
        XCTAssertLessThan(slowest, 15, "a swipe through the finished work logs didn't settle")
    }
    private func message(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text)).firstMatch
    }
}
