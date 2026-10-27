import XCTest

/// The Changes sheet against the fixture's `ios-changes` thread (`scripts/changes-scenario.ts`):
/// turn scopes, expand all, the file tree, paging a 22,000-line file, a line comment sent to the
/// agent, approving, and viewed marks. `ACE_IOS_SHOTS` keeps each screen as a PNG.
@MainActor final class ChangesReviewUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testScopesTreePagingAndALineCommentGoToTheAgent() {
        let app = launch()
        app.revealRow("thread.ios-changes").tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        let changes = app.threadMenuItem("thread.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10)); changes.tap()

        // The sheet opens on the last turn, with every scope in the title's menu.
        let scope = app.buttons["changes.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 20))
        wait(for: [expectation(for: NSPredicate(format: "label CONTAINS 'Last turn'"), evaluatedWith: scope)], timeout: 20)
        XCTAssertTrue(app.buttons["changes.file.apps/server/src/replay/window.test.ts"].waitForExistence(timeout: 20))
        capture("last-turn")
        scope.tap()
        XCTAssertTrue(app.buttons["Turn 1"].waitForExistence(timeout: 5))
        capture("scope-menu")
        app.buttons["Uncommitted"].tap()
        let shown = expectation(for: NSPredicate(format: "label CONTAINS 'Uncommitted'"), evaluatedWith: scope)
        let count = XCTWaiter.wait(for: [shown], timeout: 20) == .completed
        capture("uncommitted")
        XCTAssertTrue(count)

        // A file may already be open from the last scope: start from everything closed.
        if expandAll(app).label == "Collapse all" { expandAll(app).tap() }
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Expand all'")).firstMatch.waitForExistence(timeout: 10))
        expandAll(app).tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Collapse all'")).firstMatch.waitForExistence(timeout: 10))
        capture("expanded")
        expandAll(app).tap()

        app.buttons["changes.tree"].tap()
        let big = app.buttons["tree.data/fixtures/replay-events.jsonl"]
        for _ in 0..<8 where !big.exists { app.swipeUp() }
        XCTAssertTrue(big.waitForExistence(timeout: 10))
        capture("tree")
        big.tap()
        let more = app.buttons["diff.more"]
        XCTAssertTrue(app.buttons.matching(identifier: "diff.line").firstMatch.waitForExistence(timeout: 20))
        // Show more sits under the first 300 rows.
        for _ in 0..<30 where !more.exists { app.swipeUp(velocity: .fast) }
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        capture("paged")
        more.tap()
        // The next page lands under the rows already shown, so Show more moves down.
        sleep(3)
        capture("paged-more")

        // A comment on a line of the first file, sent to the agent.
        expandAll(app).tap() // collapse all
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.apps/server/src/replay/window.ts'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10)); first.tap()
        let line = app.buttons.matching(identifier: "diff.line").element(boundBy: 2)
        XCTAssertTrue(line.waitForExistence(timeout: 20)); line.tap()
        XCTAssertTrue(app.buttons["review.compose"].waitForExistence(timeout: 5))
        capture("line-picked")
        app.buttons["review.compose"].tap()
        let text = app.textFields["review.text"].exists ? app.textFields["review.text"] : app.textViews["review.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        // The phone keeps comments between launches, so this run's comment is told apart by its text.
        let words = "Keep the window bounded by bytes \(UUID().uuidString.prefix(6))."
        text.typeText(words)
        capture("composer")
        app.buttons["review.save"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["review.comment"].waitForExistence(timeout: 15))
        capture("draft")
        app.buttons["review.sendAll"].tap()
        let sent = app.staticTexts["Sent"].firstMatch.waitForExistence(timeout: 20)
        capture("sent")
        XCTAssertTrue(sent)

        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", words)).count, 1, "a sent comment shows once")
        app.buttons["review.list"].tap()
        if !app.buttons["review.approve"].waitForExistence(timeout: 5) { app.buttons["changes.review"].tap() }
        let approve = app.buttons["review.approve"].waitForExistence(timeout: 10)
        capture("comments")
        XCTAssertTrue(approve)
        app.buttons["review.approve"].tap()
        XCTAssertTrue(app.staticTexts["Review · Approved"].waitForExistence(timeout: 15))
        capture("approved")
        app.buttons["Done"].firstMatch.tap()

        // Viewed ticks are kept on the phone between runs: tick one that isn't ticked yet.
        let unticked = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.reviewed.' AND selected == false")).firstMatch
        XCTAssertTrue(unticked.waitForExistence(timeout: 10))
        let id = unticked.identifier
        unticked.tap()
        let ticked = expectation(for: NSPredicate(format: "selected == true"), evaluatedWith: app.buttons[id])
        wait(for: [ticked], timeout: 10)
        capture("viewed")
    }

    /// Expand all or Collapse all, whichever the row shows.
    private func expandAll(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == 'changes.expand' OR label == 'Expand all' OR label == 'Collapse all'")).firstMatch
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "changes-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("changes-\(name).png"))
        }
    }
}
