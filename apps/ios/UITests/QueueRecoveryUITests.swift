import XCTest

/// The composer's queue and sending recovery against the spike fixture (`scripts/queue-scenario.ts`):
/// a long queue's Show more, Pause queue and Resume queue, a usage limit's strip, a stopped turn's
/// Continue and a message that wasn't sent. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS`
/// (a folder) also saves each screenshot there as `queue-<name>.png`.
@MainActor final class QueueRecoveryUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testALongQueueShowsMoreAndCanBePausedAndResumed() throws {
        let app = launch(into: "ios-queue-long")
        let pill = app.buttons["pill.queue"]
        XCTAssertTrue(pill.waitForExistence(timeout: 15))
        pill.tap()
        let more = app.buttons["queue.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        XCTAssertEqual(more.label, "Show 8 more")
        screenshot("long")
        let control = app.buttons["queue.control"]
        XCTAssertEqual(control.label, "Pause queue")
        control.tap()
        XCTAssertTrue(app.buttons["Resume queue"].waitForExistence(timeout: 10))
        screenshot("paused-sheet")
        for _ in 0..<12 where !more.isHittable { app.swipeUp() }
        more.tap()
        XCTAssertTrue(app.staticTexts["Then migrate settings page 40 and check its tests"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["queue.more"].exists)
        screenshot("long-all")
        app.buttons["queue.close"].tap()
        // The paused queue says so above the composer, with its way out.
        let resume = app.buttons["hold.resume"]
        XCTAssertTrue(resume.waitForExistence(timeout: 10))
        screenshot("paused-strip")
        resume.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.hold"].waitForNonExistence(timeout: 10))
    }

    func testAUsageLimitOffersSwitchResumeAtResetAndContinue() throws {
        let app = launch(into: "ios-limited")
        let sentence = app.staticTexts["hold.sentence"]
        XCTAssertTrue(sentence.waitForExistence(timeout: 15))
        XCTAssertTrue(sentence.label.hasPrefix("Codex is out of usage until"))
        XCTAssertTrue(app.buttons["hold.choose_model"].exists)
        XCTAssertTrue(app.buttons["hold.resume_now"].exists)
        screenshot("limit")
        app.buttons["hold.resume_at_reset"].tap()
        let scheduled = NSPredicate(format: "label CONTAINS 'resumes'")
        wait(for: [expectation(for: scheduled, evaluatedWith: sentence)], timeout: 10)
        screenshot("limit-scheduled")
        app.buttons["hold.choose_model"].tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10))
        screenshot("limit-switch")
    }

    func testAStoppedTurnOffersContinue() throws {
        let app = launch(into: "ios-stopped")
        let carry = app.buttons["hold.continue"]
        XCTAssertTrue(carry.waitForExistence(timeout: 15))
        screenshot("stopped")
        carry.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.hold"].waitForNonExistence(timeout: 10))
    }

    func testAMessageThatWasntSentCanBeInspectedEditedOrRemoved() throws {
        let app = launch(into: "ios-held-send")
        let details = app.buttons["notSent.details"]
        XCTAssertTrue(details.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Now add retries with backoff to the webhook handler"].exists)
        screenshot("not-sent")
        details.tap()
        XCTAssertTrue(app.descendants(matching: .any)["notSent.detail"].waitForExistence(timeout: 5))
        screenshot("not-sent-details")
        app.buttons["notSent.remove"].tap()
        XCTAssertTrue(app.buttons["Remove message"].waitForExistence(timeout: 5))
        screenshot("not-sent-remove")
        // The sheet's Cancel is a tap outside it on iOS 26.
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.exists { cancel.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap() }
        XCTAssertTrue(app.buttons["Remove message"].waitForNonExistence(timeout: 5))
        app.buttons["notSent.edit"].tap()
        // Its words go back into the composer, and it leaves the transcript.
        let input = app.textViews["composer.input"]
        let restored = NSPredicate(format: "value CONTAINS 'retries with backoff'")
        wait(for: [expectation(for: restored, evaluatedWith: input)], timeout: 10)
        // The daemon keeps the queue held for the next message, which now heads it.
        XCTAssertTrue(app.staticTexts["Now add retries with backoff to the webhook handler"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Then write the tests"].waitForExistence(timeout: 10))
        screenshot("not-sent-edited")
    }

    private func launch(into thread: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        app.revealRow("thread.\(thread)").tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        return app
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-queue-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("queue-\(name).png"))
        }
    }
}
