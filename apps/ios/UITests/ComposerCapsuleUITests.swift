import XCTest

/// The thread composer as one capsule, against the spike fixture (`TEST_RUNNER_ACE_IOS_SPIKE_PORT`
/// selects its port): + on its left, one trailing button that is the microphone, Send or Stop by
/// state, the live line or a request strip above it, chips above it, and the model in the
/// thread's title menu. `TEST_RUNNER_ACE_IOS_SHOTS` names a folder for the screenshots.
@MainActor final class ComposerCapsuleUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testAnIdleCapsuleOffersTheMicrophoneThenSendOnceThereAreWordsAndGrowsAsTheyWrap() {
        let app = launch(into: "thread.ios-done")
        let field = app.otherElements["composer.surface"].firstMatch
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        XCTAssertTrue(app.buttons["composer.dictate"].exists, "an empty idle composer offers the microphone")
        XCTAssertFalse(app.buttons["composer.send"].exists)
        XCTAssertLessThan(app.buttons["composer.attach"].frame.maxX, field.frame.minX, "+ sits outside the capsule")
        XCTAssertFalse(app.descendants(matching: .any)["composer.live"].exists, "nothing live when idle")
        let oneLine = field.frame.height
        XCTAssertGreaterThanOrEqual(oneLine, 44)
        shot("idle")
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(field.frame.height, oneLine, accuracy: 1, "the keyboard alone doesn't make the capsule taller")
        input.typeText("Skip ephemeral events in the replay window and raise the protocol limit to two hundred")
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 5), "words make the button Send")
        XCTAssertFalse(app.buttons["composer.dictate"].exists)
        XCTAssertGreaterThan(field.frame.height, oneLine + 10, "wrapped words grow the capsule")
        XCTAssertLessThanOrEqual(field.frame.maxY, app.keyboards.firstMatch.frame.minY)
        shot("typing")
    }

    func testAWorkingTreeShowsTheLiveLineAndStopInTheCapsule() {
        let app = launch(into: "thread.ios-waiting")
        let live = app.descendants(matching: .any)["composer.live"]
        XCTAssertTrue(live.waitForExistence(timeout: 25))
        let status = app.descendants(matching: .any)["pill.status"].firstMatch
        XCTAssertTrue(status.label.hasPrefix("Waiting on"), status.label)
        let input = app.textViews["composer.input"]
        // The line sits right above the capsule, starting where the field's words start.
        XCTAssertLessThanOrEqual(live.frame.maxY, input.frame.minY + 1)
        XCTAssertLessThan(live.frame.minY, input.frame.minY)
        let stop = app.buttons["composer.send"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        XCTAssertEqual(stop.label, "Stop whole agent tree")
        // Mid-transcript, the words run under the header's fade rather than through the title.
        let transcript = app.scrollViews["transcript"]
        transcript.swipeDown(velocity: .fast)
        sleep(1)
        // Then the first message partly under the header.
        let from = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        from.press(forDuration: 0.1, thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.48)))
        sleep(2)
        XCTAssertTrue(app.buttons["thread.title"].isHittable)
        shot("working")
    }

    func testAWorkingTreeWithAQueueAndAGoalShowsEachAsItsOwnPillInOneRow() {
        let app = launch(into: "thread.ios-queue-long")
        let status = app.descendants(matching: .any)["pill.status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 25))
        let queue = app.buttons["pill.queue"]
        let goal = app.buttons["pill.goal"]
        XCTAssertTrue(queue.waitForExistence(timeout: 10))
        XCTAssertTrue(goal.exists)
        XCTAssertEqual(queue.label, "40 queued")
        // One row, status first, each its own capsule, starting at the field's left edge.
        XCTAssertEqual(status.frame.midY, queue.frame.midY, accuracy: 1)
        XCTAssertLessThan(status.frame.maxX, queue.frame.minX)
        XCTAssertLessThan(queue.frame.maxX, goal.frame.minX)
        // The capsule starts one gap past the +.
        let attach = app.buttons["composer.attach"]
        XCTAssertEqual(status.frame.minX, attach.frame.maxX + 8, accuracy: 2, "the pills start at the field's left edge")
        XCTAssertLessThanOrEqual(status.frame.maxY, attach.frame.minY)
        shot("working-queue-goal")
        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["queue.strip"].waitForExistence(timeout: 10), "the queue pill opens the queue")
    }

    func testAnApprovalTakesTheLiveLinesPlaceAndThePlaceholderAsksForAReply() {
        let app = launch(into: "thread.ios-approval")
        let strip = app.descendants(matching: .any)["request.approval"].firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 25))
        XCTAssertFalse(app.descendants(matching: .any)["composer.live"].exists)
        let input = app.textViews["composer.input"]
        XCTAssertEqual(input.label, "Reply or answer")
        XCTAssertLessThanOrEqual(strip.frame.maxY, input.frame.minY)
        shot("approval")
    }

    func testTheTitleOpensOneMenuWithModelEffortAndAccessFirst() {
        let app = launch(into: "thread.ios-done")
        let title = app.threadTitle(timeout: 25)
        XCTAssertTrue(title.label.contains("· Med") || (title.value as? String)?.contains("Med") == true, "the title's line reads the model and effort")
        // The page pills still sit right under the title.
        let pages = app.descendants(matching: .any)["thread.pages"].firstMatch
        if pages.exists { XCTAssertGreaterThanOrEqual(pages.frame.minY, title.frame.maxY - 1) }
        title.tap()
        let model = app.titleMenuItem("thread.title.model", label: "Model")
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        XCTAssertTrue(app.titleMenuItem("thread.rename", label: "Rename").exists, "the thread's own actions stay in the menu")
        shot("title-menu")
        model.tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 15))
    }

    func testALineCommentRidesAboveTheCapsuleAndSendsWithoutWords() {
        let app = launch(into: "thread.ios-changes")
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        let changes = app.threadMenuItem("thread.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10)); changes.tap()
        // A turn's line numbers aren't the checkout's: comments go on the uncommitted changes.
        let lastTurn = app.buttons.matching(NSPredicate(format: "identifier == 'changes.scope' OR label BEGINSWITH 'Last turn'")).firstMatch
        XCTAssertTrue(lastTurn.waitForExistence(timeout: 20))
        lastTurn.tap()
        XCTAssertTrue(app.buttons["Uncommitted"].waitForExistence(timeout: 5))
        app.buttons["Uncommitted"].tap()
        let uncommitted = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Uncommitted'")).firstMatch
        XCTAssertTrue(uncommitted.waitForExistence(timeout: 20))
        let expand = app.buttons.matching(NSPredicate(format: "identifier == 'changes.expand' OR label == 'Expand all' OR label == 'Collapse all'")).firstMatch
        if expand.waitForExistence(timeout: 5), expand.label == "Collapse all" { expand.tap() }
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.apps/server/src/replay/window.ts'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 20)); first.tap()
        let line = app.buttons.matching(identifier: "diff.line").element(boundBy: 2)
        XCTAssertTrue(line.waitForExistence(timeout: 20)); line.tap()
        // The Changes page names its own controls; they are found by their words.
        let compose = button(app, "review.compose", "Comment")
        XCTAssertTrue(compose.waitForExistence(timeout: 5)); compose.tap()
        let text = app.descendants(matching: .any).matching(NSPredicate(format: "(elementType == %d OR elementType == %d) AND (identifier == 'review.text' OR placeholderValue == 'Comment')",
                                                                        XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue)).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.typeText("Keep the window bounded by bytes.")
        button(app, "review.save", "Save").tap()
        let chat = app.buttons["thread.page.chat"]
        if !chat.waitForExistence(timeout: 3) { app.closeSheet() }
        if chat.exists { chat.tap() }
        let chip = app.buttons["composer.comments"]
        XCTAssertTrue(chip.waitForExistence(timeout: 15))
        let field = app.otherElements["composer.surface"].firstMatch
        XCTAssertLessThanOrEqual(chip.frame.maxY, field.frame.minY + 1, "the chip rides above the capsule")
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 5), "a chip alone makes the button Send")
        shot("comment-chip")
    }

    // MARK: - Fixture

    private func button(_ app: XCUIApplication, _ identifier: String, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", identifier, label)).firstMatch
    }

    private func launch(into row: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        dismissNotificationsPrompt()
        app.revealRow(row).tap()
        return app
    }

    private func dismissNotificationsPrompt() {
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            let deny = alert.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch
            if deny.exists { deny.tap() }
        }
    }

    private func shot(_ name: String) {
        let screen = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screen)
        attachment.name = "composer-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? screen.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
