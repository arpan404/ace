import XCTest

/// The thread screen against the spike fixture's thread scenarios, with screenshots. Run on a
/// fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testWorkedTurnSubagentsChildThreadAndModelPicker() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        screenshot("thread-inbox")
        app.buttons["thread.ios-agents"].tap()
        let worked = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(worked.waitForExistence(timeout: 25))
        swipeToTop(app)
        screenshot("thread-transcript")
        worked.tap()
        screenshot("thread-worked-expanded")
        app.buttons["subagents.rollup"].firstMatch.tap()
        let review = app.buttons["subagent.Review PID-reuse safety"]
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        // The opened rows run two lines each: bring the last above the strip and composer.
        clearOfComposer(review, in: app)
        review.tap()
        XCTAssertTrue(app.staticTexts["Review the kill-all change for PID-reuse safety."].waitForExistence(timeout: 25))
        screenshot("thread-child")
        app.navigationBars.buttons.firstMatch.tap()
        let tests = app.buttons["subagent.Write orphan-cleanup tests"]
        XCTAssertTrue(tests.waitForExistence(timeout: 25))
        clearOfComposer(tests, in: app)
        tests.tap()
        XCTAssertTrue(app.staticTexts["Writing the PID-reuse regression."].waitForExistence(timeout: 10))
        screenshot("thread-agent-lane")
        app.buttons["Done"].tap()
        app.composerControl("composer.model").tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 10))
        sleep(2)
        screenshot("thread-models")
        app.closeSheet()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Then update the docs")
        app.buttons["composer.send"].tap()
        // A queued message joins the pill over the composer, whose "1 queued" opens the queue; one
        // that went in now is in the transcript.
        let queued = app.buttons["pill.queue"]
        if queued.waitForExistence(timeout: 15) {
            queued.tap()
            XCTAssertTrue(app.descendants(matching: .any)["queue.strip"].waitForExistence(timeout: 10))
            screenshot("thread-queue")
            app.buttons["queue.close"].tap()
        } else {
            XCTAssertTrue(app.staticTexts["Then update the docs"].waitForExistence(timeout: 5))
        }
        app.buttons["thread.menu"].tap()
        XCTAssertTrue(app.buttons["Stop all agents"].waitForExistence(timeout: 10))
        screenshot("thread-menu")
    }
    /// With the subagents opened at the thread's end, the feed still scrolls the last line fully
    /// above the strip and composer, and "Scroll to end" stays away while the end is in view.
    func testLastLineClearsComposerWithSubagentsOpen() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        app.buttons["thread.ios-agents"].tap()
        let rollup = app.buttons["subagents.rollup"].firstMatch
        XCTAssertTrue(rollup.waitForExistence(timeout: 25))
        clearOfComposer(rollup, in: app)
        rollup.tap()
        XCTAssertTrue(app.buttons["subagent.Review PID-reuse safety"].waitForExistence(timeout: 10))
        let transcript = app.scrollViews["transcript"]
        for _ in 0..<3 { transcript.swipeUp(velocity: .fast) }
        sleep(2)
        screenshot("thread-end-subagents-open")
        let last = app.staticTexts["Wiring the filters while the agents work"]
        XCTAssertTrue(last.waitForExistence(timeout: 5))
        let input = app.textViews["composer.input"]
        let pill = app.descendants(matching: .any)["thread.pill"]
        let barTop = pill.exists ? min(pill.frame.minY, input.frame.minY) : input.frame.minY
        XCTAssertLessThanOrEqual(last.frame.maxY, barTop, "the last line sits under the composer")
        XCTAssertFalse(app.buttons["transcript.latest"].exists, "Scroll to end shows at the end")
        // Opened again while at the end, the rows push the end up rather than under the composer.
        rollup.tap()
        XCTAssertTrue(app.buttons["subagent.Review PID-reuse safety"].waitForNonExistence(timeout: 5))
        sleep(1)
        rollup.tap()
        XCTAssertTrue(app.buttons["subagent.Review PID-reuse safety"].waitForExistence(timeout: 5))
        sleep(2)
        screenshot("thread-end-subagents-reopened")
        XCTAssertLessThanOrEqual(last.frame.maxY, barTop, "opening the rows at the end hides the last line")
        XCTAssertFalse(app.buttons["transcript.latest"].exists, "Scroll to end shows after opening the rows at the end")
    }
    func testQuestionAndApprovalCards() {
        let app = launch()
        reveal("thread.ios-question", in: app)
        app.buttons["thread.ios-question"].tap()
        XCTAssertTrue(app.buttons["question.answer"].waitForExistence(timeout: 25))
        // The question sits on the strip with the composer still under it, as on the web; the
        // transcript says who asks it.
        XCTAssertTrue(app.textViews["composer.input"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["transcript.question"].waitForExistence(timeout: 10))
        app.buttons["question.archive.skip"].tap()
        screenshot("thread-question")
        app.navigationBars.buttons.firstMatch.tap()
        reveal("thread.ios-approval", in: app)
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_session"].waitForExistence(timeout: 25))
        screenshot("thread-approval")
    }
    /// Leaving a scrolled transcript with a "Worked for" log open tears its views down after the
    /// thread's session closed; their releases must not surface as a failed request in the inbox.
    func testBackFromScrolledThreadShowsNoRequestAlert() {
        let app = launch()
        for round in 0..<3 {
            reveal("thread.ios-agents", in: app)
            app.buttons["thread.ios-agents"].tap()
            let worked = app.buttons["work.toggle"].firstMatch
            XCTAssertTrue(worked.waitForExistence(timeout: 25))
            let transcript = app.scrollViews["transcript"]
            transcript.swipeDown(velocity: .fast)
            if round == 0, worked.isHittable { worked.tap() }
            transcript.swipeUp(velocity: .fast)
            transcript.swipeDown(velocity: .fast)
            app.navigationBars.buttons.firstMatch.tap()
            XCTAssertTrue(app.buttons["thread.ios-agents"].waitForExistence(timeout: 10))
            let alert = app.alerts["Request needs attention"]
            if alert.waitForExistence(timeout: 3) {
                screenshot("back-request-alert")
                XCTFail("Back from a scrolled thread raised: \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
                return
            }
        }
    }
    /// Words typed and left unsent come back on returning to the thread and after the app is killed.
    func testUnsentWordsSurviveLeavingTheThreadAndARelaunch() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        app.buttons["thread.ios-agents"].tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        input.tap()
        input.typeText("Half a thought")
        app.navigationBars.buttons.firstMatch.tap()
        reveal("thread.ios-agents", in: app)
        app.buttons["thread.ios-agents"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        XCTAssertEqual(input.value as? String, "Half a thought")
        app.terminate()
        let relaunched = XCUIApplication()
        relaunched.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841", "--spike-keep-state"]
        relaunched.launch()
        // The relaunch reopens the thread it was killed on, words and all.
        let restored = relaunched.textViews["composer.input"]
        XCTAssertTrue(restored.waitForExistence(timeout: 25))
        XCTAssertEqual(restored.value as? String, "Half a thought")
        screenshot("thread-draft-restored")
    }
    /// What's live floats over the composer as one pill, never a line in the transcript; a goal
    /// joins it, and its sheet pauses and resumes the goal. A request takes the pill's place.
    func testLivePillGoalSheetAndRequestTakingItsPlace() {
        let app = launch()
        app.revealRow("thread.ios-waiting").tap()
        let status = app.descendants(matching: .any)["pill.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 25))
        XCTAssertTrue(status.label.hasPrefix("Waiting on"), "the main agent only waits: \(status.label)")
        XCTAssertFalse(app.descendants(matching: .any)["thread.live"].exists, "no live line in the transcript")
        app.buttons["pill.status"].tap()
        XCTAssertTrue(app.buttons["agents.close"].waitForExistence(timeout: 10), "Waiting on opens the agent tree")
        app.buttons["agents.close"].tap()
        app.navigationBars.buttons.firstMatch.tap()

        app.revealRow("thread.ios-goal").tap()
        let goal = app.buttons["pill.goal"]
        XCTAssertTrue(goal.waitForExistence(timeout: 25))
        XCTAssertEqual(goal.label, "Pursuing goal")
        goal.tap()
        XCTAssertTrue(app.staticTexts["Not met yet: the two refund tests still fail on a fixed clock"].waitForExistence(timeout: 10))
        screenshot("thread-goal")
        app.buttons["goal.pause"].tap()
        XCTAssertTrue(app.buttons["goal.resume"].waitForExistence(timeout: 10), "a paused goal offers Resume")
        XCTAssertTrue(app.navigationBars["Goal paused"].exists)
        // Clear asks first, naming the goal; Cancel keeps it.
        app.buttons["goal.clear"].tap()
        XCTAssertTrue(app.alerts["Clear this goal?"].waitForExistence(timeout: 5))
        app.alerts.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["goal.resume"].waitForExistence(timeout: 5), "Cancel keeps the goal")
        app.buttons["goal.resume"].tap()
        XCTAssertTrue(app.buttons["goal.pause"].waitForExistence(timeout: 10))
        app.buttons["goal.close"].tap()
        XCTAssertEqual(app.buttons["pill.goal"].label, "Pursuing goal")
        app.navigationBars.buttons.firstMatch.tap()

        // Confirmed, the goal clears and leaves the pill. (A second thread, so the first keeps its
        // goal for the contract tests on the same fixture.)
        app.revealRow("thread.ios-goal-other").tap()
        XCTAssertTrue(app.buttons["pill.goal"].waitForExistence(timeout: 25))
        app.buttons["pill.goal"].tap()
        XCTAssertTrue(app.buttons["goal.clear"].waitForExistence(timeout: 10))
        app.buttons["goal.clear"].tap()
        XCTAssertTrue(app.alerts["Clear this goal?"].waitForExistence(timeout: 5))
        app.alerts["Clear this goal?"].buttons["Clear goal"].firstMatch.tap()
        XCTAssertTrue(app.buttons["pill.goal"].waitForNonExistence(timeout: 10), "a cleared goal leaves the pill")
        XCTAssertFalse(app.buttons["goal.close"].exists, "and its sheet closes")
        app.navigationBars.buttons.firstMatch.tap()

        app.revealRow("thread.ios-approval").tap()
        XCTAssertTrue(app.buttons["approval.allow_session"].waitForExistence(timeout: 25))
        XCTAssertFalse(app.descendants(matching: .any)["thread.pill"].exists, "a request takes the pill's place")
    }
    /// A long press on an answer offers Copy, Select text and Share; Select text opens the words
    /// where any part of them can be selected.
    func testLongPressOnAnAnswerOffersCopySelectAndShare() {
        let app = launch()
        reveal("thread.ios-code", in: app)
        app.buttons["thread.ios-code"].tap()
        let prose = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Here is the class'")).firstMatch
        XCTAssertTrue(prose.waitForExistence(timeout: 25))
        prose.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Share"].exists)
        app.buttons["Select text"].tap()
        let words = app.textViews["select.text"]
        XCTAssertTrue(words.waitForExistence(timeout: 5))
        XCTAssertTrue((words.value as? String)?.contains("export class RetryBudget") == true)
        app.buttons["select.done"].tap()
    }
    /// Ended in the background, as the system ends apps for memory, the app comes back on the
    /// thread it showed instead of the inbox; back at the inbox, the next launch starts there.
    func testTheOpenThreadComesBackAfterTheAppIsEndedInTheBackground() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        app.buttons["thread.ios-agents"].tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 25))
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.terminate()
        app.launchArguments.append("--spike-keep-state")
        app.launch()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["work.toggle"].firstMatch.waitForExistence(timeout: 25))
        screenshot("thread-restored")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 30))
        sleep(3)
        XCTAssertFalse(app.buttons["thread.menu"].exists)
    }
    /// A search hit opens its thread at the message, in the thread's own history window, and
    /// Scroll to end returns to the live end.
    func testAFocusedMessageOpensInTheHistoryWindowAndScrollToEndReturnsLive() {
        let app = XCUIApplication()
        // The fixture's 101st history message (the agent, turn and its run come first).
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-items", "200", "--spike-open", "ios-stream", "--spike-focus", "ios-stream.item.103"]
        app.launch()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        let target = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "History 101.")).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 20), "the focused message is shown")
        XCTAssertTrue(target.isHittable, "the focused message is on screen")
        XCTAssertEqual(transcript.value as? String, "Reading history")
        app.buttons["Scroll to end"].tap()
        let ready = expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: transcript)
        wait(for: [ready], timeout: 10)
        XCTAssertFalse(target.exists, "the window around the old message is gone")
        screenshot("focused-message-back-live")
    }
    /// A fork's transcript draws "Forked from <source>" where its own work starts; the title opens
    /// the source thread. A fork whose source the thread list doesn't know names it in plain words.
    func testForkedFromDividerOpensTheSourceThread() {
        let app = open("ios-fork")
        let divider = app.buttons["transcript.forked"]
        XCTAssertTrue(divider.waitForExistence(timeout: 30))
        XCTAssertEqual(divider.label, "Forked from Tighten the composer spacing")
        screenshot("thread-forked-from")
        divider.tap()
        XCTAssertTrue(app.navigationBars["Tighten the composer spacing"].waitForExistence(timeout: 15))
        app.terminate()
        let gone = open("ios-fork-gone")
        let plain = gone.descendants(matching: .any)["transcript.forked"]
        XCTAssertTrue(plain.waitForExistence(timeout: 30))
        XCTAssertEqual(plain.label, "Forked from the earlier thread")
        XCTAssertFalse(gone.buttons["transcript.forked"].exists, "a source the list doesn't know opens nothing")
    }
    private func open(_ threadId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-open", threadId]
        app.launch()
        return app
    }
    /// The inbox lists more fixture threads than fit; scroll until the row shows.
    private func reveal(_ identifier: String, in app: XCUIApplication) {
        let row = app.buttons[identifier]
        _ = row.waitForExistence(timeout: 25)
        for _ in 0..<4 where !row.isHittable { app.dragListUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    /// Scrolls the transcript until `row` sits above the strip and composer at the bottom.
    private func clearOfComposer(_ row: XCUIElement, in app: XCUIApplication) {
        let input = app.textViews["composer.input"]
        for _ in 0..<4 where input.exists && row.frame.maxY > input.frame.minY - 120 {
            app.scrollViews["transcript"].swipeUp(velocity: .slow)
        }
    }
    private func swipeToTop(_ app: XCUIApplication) {
        let transcript = app.scrollViews["transcript"]
        if transcript.exists { transcript.swipeDown(velocity: .fast) }
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
