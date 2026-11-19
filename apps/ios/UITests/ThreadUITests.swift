import XCTest

/// The thread screen against the spike fixture's thread scenarios, with screenshots. Run on a
/// fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ThreadUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testThreadLoadsAndOptionsOpenAfterBackgrounding() {
        executionTimeAllowance = 60
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 20))
        expectation(for: NSPredicate(format: "value == 'Ready'"), evaluatedWith: transcript)
        waitForExpectations(timeout: 15)
        XCUIDevice.shared.press(.home)
        app.activate()
        let options = app.buttons["thread.menu"]
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        XCTAssertTrue(app.buttons["thread.files"].waitForExistence(timeout: 10))
    }

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
        // The subagents still work: the pill says so and opens their tree, and the transcript
        // keeps no live row for them until they have ended.
        XCTAssertFalse(app.buttons["subagents.rollup"].exists, "a live tree shows once, on the pill")
        app.openAgentsFromPill()
        let review = app.agentsRow("Review PID-reuse safety")
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        review.tap()
        XCTAssertTrue(app.staticTexts["Review the kill-all change for PID-reuse safety."].waitForExistence(timeout: 25))
        screenshot("thread-child")
        app.navigationBars.buttons.firstMatch.tap()
        app.openAgentsFromPill()
        let tests = app.agentsRow("Write orphan-cleanup tests")
        XCTAssertTrue(tests.waitForExistence(timeout: 25))
        tests.tap()
        XCTAssertTrue(words("Writing the PID-reuse regression.", in: app).waitForExistence(timeout: 10))
        screenshot("thread-agent-lane")
        // The lane is pushed over the agent tree: back to the tree, then away from it (its X where
        // the tree is a sheet, back where it is a page), until the thread is in front again.
        for _ in 0..<4 where !app.textViews["composer.input"].isHittable {
            if app.buttons["agents.close"].isHittable { app.buttons["agents.close"].tap() } else { app.navigationBars.buttons.element(boundBy: 0).tap() }
            sleep(1)
        }
        XCTAssertTrue(app.textViews["composer.input"].waitForExistence(timeout: 10))
        app.openModelPicker()
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
    /// While the subagents work, their tree is the pill's: the thread's end clears the pill and
    /// composer with no live group above it, and "Scroll to end" stays away at the end.
    func testLastLineClearsComposerWhileSubagentsWork() {
        let app = launch()
        reveal("thread.ios-agents", in: app)
        app.buttons["thread.ios-agents"].tap()
        let last = words("Wiring the filters while the agents work", in: app)
        XCTAssertTrue(last.waitForExistence(timeout: 25))
        let pill = app.descendants(matching: .any)["composer.live"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["subagents.rollup"].exists, "the live tree is on the pill, not in the transcript")
        let transcript = app.scrollViews["transcript"]
        for _ in 0..<3 { transcript.swipeUp(velocity: .fast) }
        sleep(2)
        screenshot("thread-end-subagents-on-pill")
        let input = app.textViews["composer.input"]
        let barTop = min(pill.frame.minY, input.frame.minY)
        XCTAssertLessThanOrEqual(last.frame.maxY, barTop, "the last line sits under the composer")
        XCTAssertFalse(app.buttons["transcript.latest"].exists, "Scroll to end shows at the end")
    }
    func testReadingBackOffersScrollToEndAndNothingBesideTheTranscript() {
        let app = launch()
        // Far down the fixture's inbox: the shared helper scrolls until the row is in the middle.
        app.revealRow("thread.ios-log-long").tap()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 25))
        // Reading back offers Scroll to end over the composer, and nothing over the transcript's
        // trailing edge: no turn rail, its ticks or its card (#2173).
        for _ in 0..<2 { transcript.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.buttons["transcript.latest"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["transcript.turnRail"].exists, "a turn rail shows beside the transcript")
        XCTAssertFalse(app.otherElements["Turns"].exists, "VoiceOver finds a turn rail beside the transcript")
        // Read back, the app goes idle: every query waits for idle first, so one that takes
        // seconds means the main thread is caught in an update loop.
        sleep(1)
        let asked = Date()
        _ = transcript.frame
        XCTAssertLessThan(Date().timeIntervalSince(asked), 5, "the app never went idle reading back")
        screenshot("reading-back")
        // Scroll to end goes back to the live end, where it no longer shows.
        app.buttons["transcript.latest"].tap()
        XCTAssertTrue(app.buttons["transcript.latest"].waitForNonExistence(timeout: 15))
    }
    func testASwipeAlongTheTranscriptsTrailingEdgeScrollsIt() {
        let app = launch()
        app.revealRow("thread.ios-log-long").tap()
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 25))
        for _ in 0..<2 { transcript.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.buttons["transcript.latest"].waitForExistence(timeout: 10))
        sleep(1)
        // An ask on screen to watch: the swipe must move it.
        let asks = (1...6).map { app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Keep relay cursors, part \($0).")).firstMatch }
        guard let watched = asks.first(where: { $0.exists && $0.isHittable }) else { XCTFail("no ask on screen"); return }
        let before = watched.frame.minY
        // A quick vertical swipe that starts 8 pt in from the screen's trailing edge.
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.6)).withOffset(CGVector(dx: -8, dy: 0))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -250)))
        sleep(1)
        XCTAssertTrue(!watched.exists || watched.frame.minY < before - 100, "a swipe along the trailing edge didn't scroll the transcript")
        // It only scrolled: Scroll to end is still offered.
        XCTAssertTrue(app.buttons["transcript.latest"].exists)
    }
    func testQuestionAndApprovalCards() {
        let app = launch()
        reveal("thread.ios-question", in: app)
        app.buttons["thread.ios-question"].tap()
        // The question waits on a strip with the composer still under it, as on the web. While
        // it's asking, the strip is its one place: the transcript doesn't repeat it.
        let strip = app.descendants(matching: .any)["request.question"]
        let answer = strip.buttons["strip.answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 25))
        XCTAssertTrue(app.textViews["composer.input"].exists)
        XCTAssertTrue(strip.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "archived 0.x entries")).firstMatch.exists,
            "the strip carries the question")
        // Only once the transcript has loaded can the question's absence from it mean anything.
        let transcript = app.scrollViews["transcript"]
        let ready = expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: transcript)
        wait(for: [ready], timeout: 25)
        XCTAssertTrue(app.descendants(matching: .any)["message.user.ios-question.item.3"].waitForExistence(timeout: 10),
            "the transcript shows the message that asked")
        XCTAssertFalse(app.descendants(matching: .any)["transcript.question"].exists,
            "the transcript doesn't repeat a question that is still asking")
        // Answer opens the question's options in a sheet; picking one lets it be answered.
        answer.tap()
        let send = app.buttons["question.answer"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertFalse(send.isEnabled, "nothing is picked yet")
        app.buttons["question.archive.skip"].tap()
        XCTAssertTrue(send.isEnabled)
        screenshot("thread-question")
        app.buttons["request.close"].tap()
        XCTAssertTrue(send.waitForNonExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        reveal("thread.ios-approval", in: app)
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_session"].waitForExistence(timeout: 25))
        screenshot("thread-approval")
        // The answers are real buttons: each a full tap tall, none flush against another, so Deny
        // is never a hair from Allow.
        app.assertStripButtons(["approval.deny", "approval.allow_session", "approval.allow_once"])
        // Tapping the request's words opens its details, with every option.
        app.buttons["request.details"].tap()
        XCTAssertTrue(app.buttons["request.close"].waitForExistence(timeout: 10))
        screenshot("thread-approval-details")
        app.buttons["request.close"].tap()
        XCTAssertTrue(app.buttons["request.close"].waitForNonExistence(timeout: 5))
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
        relaunched.launchWithArguments()
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
        // On a phone the agent tree is pushed over the thread.
        XCTAssertTrue(app.descendants(matching: .any)["agents.summary"].waitForExistence(timeout: 10), "Waiting on opens the agent tree")
        let tree = app.descendants(matching: .any)["agents.summary"]
        app.tapBack()
        XCTAssertTrue(tree.waitForNonExistence(timeout: 10), "back returns to the thread")
        XCTAssertTrue(app.buttons["pill.status"].isHittable)
        app.tapBack()

        app.revealRow("thread.ios-goal").tap()
        let goal = app.buttons["pill.goal"]
        XCTAssertTrue(goal.waitForExistence(timeout: 25))
        // Its progress reads beside its state, as the web's goal strip shows it.
        XCTAssertEqual(goal.label, "Pursuing goal · 182K tokens · 32m 0s · 3 checks")
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
        XCTAssertEqual(app.buttons["pill.goal"].label, "Pursuing goal · 182K tokens · 32m 0s · 3 checks")
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
        XCTAssertFalse(app.descendants(matching: .any)["composer.live"].exists, "a request takes the live line's place")
    }
    /// A long press on an answer offers Copy, Select text and Share; Select text opens the words
    /// where any part of them can be selected.
    func testLongPressOnAnAnswerOffersCopySelectAndShare() {
        // The fixture lists more threads than a few scrolls reach, so this one opens at launch.
        let app = open("ios-code")
        let prose = words("Here is the class as it stands:", in: app)
        XCTAssertTrue(prose.waitForExistence(timeout: 30))
        prose.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Share"].exists)
        app.buttons["Select text"].tap()
        let selectable = app.textViews["select.text"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 5))
        XCTAssertTrue((selectable.value as? String)?.contains("export class RetryBudget") == true)
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
        app.launchWithArguments()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["work.toggle"].firstMatch.waitForExistence(timeout: 25))
        screenshot("thread-restored")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 10))
        app.terminate()
        app.launchWithArguments()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 30))
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
        app.launchWithArguments()
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
    /// A turn ace restarted and a usage limit held reads as one "Worked for". Folded, nothing in
    /// it mentions the restarts; opened, each restart, the wait and the results that landed
    /// together is one quiet row among the steps (#2132).
    func testARestartedTurnShowsItsRestartsAndWaitOnlyOnceWorkedForOpens() {
        let app = open("ios-log-restarted")
        let toggle = app.buttons["work.toggle"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 25))
        for _ in 0..<6 where !toggle.isHittable { swipeToTop(app) }
        let moment = { (text: String) in
            app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
        }
        XCTAssertFalse(moment("Restarted").exists, "a folded turn says nothing about its restarts")
        screenshot("restarted-folded")
        toggle.tap()
        _ = moment("Restarted twice, continued").waitForExistence(timeout: 15)
        sleep(1)
        screenshot("restarted-open")
        XCTAssertTrue(moment("Restarted twice, continued").exists)
        XCTAssertTrue(moment("Restarted, continued").exists)
        XCTAssertTrue(moment("2 subagents finished").exists)
        let wait = moment("Waited for the usage limit")
        for _ in 0..<4 where !(wait.exists && wait.isHittable) { app.scrollViews["transcript"].swipeUp(velocity: .slow) }
        XCTAssertTrue(wait.exists)
        screenshot("restarted-open-wait")
    }
    /// A step still in flight is its own row after the steps that ran, its time counting up.
    func testAStepInFlightReadsRunningBesideTheOneThatRan() {
        let app = open("ios-log-parallel")
        let running = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'step.' AND label CONTAINS 'bun run slow'")).firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 25))
        XCTAssertEqual(running.value as? String, "Running")
        sleep(2)
        screenshot("step-running")
    }
    private func open(_ threadId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-open", threadId]
        app.launchWithArguments()
        return app
    }
    /// The inbox lists more fixture threads than fit; scroll until the row shows.
    private func reveal(_ identifier: String, in app: XCUIApplication) {
        let row = app.buttons[identifier]
        _ = row.waitForExistence(timeout: 25)
        for _ in 0..<4 where !row.isHittable { app.dragListUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 5))
    }
    /// Agent prose as drawn: markit puts each block in a text view whose value is its words.
    private func words(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.textViews.matching(NSPredicate(format: "value CONTAINS %@", text)).firstMatch
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
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
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        // `ACE_IOS_SHOTS` (a folder) also keeps each one there, for a PR's before and after.
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
