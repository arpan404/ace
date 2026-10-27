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
        XCTAssertTrue(app.staticTexts["Last turn"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["changes.file.apps/server/src/replay/window.test.ts"].waitForExistence(timeout: 20))
        capture("last-turn")
        scope.tap()
        XCTAssertTrue(app.buttons["Turn 1"].waitForExistence(timeout: 5))
        capture("scope-menu")
        app.buttons["Uncommitted"].tap()
        XCTAssertTrue(app.staticTexts["44 files"].waitForExistence(timeout: 20))

        app.buttons["changes.expand"].tap()
        XCTAssertTrue(app.buttons["Collapse all"].waitForExistence(timeout: 10))
        capture("expanded")
        app.buttons["changes.expand"].tap()

        app.buttons["changes.tree"].tap()
        let big = app.buttons["tree.data/fixtures/replay-events.jsonl"]
        XCTAssertTrue(big.waitForExistence(timeout: 10))
        capture("tree")
        big.tap()
        let more = app.buttons["diff.more"]
        XCTAssertTrue(more.waitForExistence(timeout: 20))
        capture("paged")
        more.tap()
        XCTAssertTrue(app.buttons["diff.more"].waitForExistence(timeout: 20))

        // A comment on a line of the first file, sent to the agent.
        app.buttons["changes.expand"].tap() // collapse all
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.apps/server/src/replay/window.ts'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10)); first.tap()
        let line = app.buttons.matching(identifier: "diff.line").element(boundBy: 2)
        XCTAssertTrue(line.waitForExistence(timeout: 20)); line.tap()
        XCTAssertTrue(app.buttons["review.compose"].waitForExistence(timeout: 5))
        capture("line-picked")
        app.buttons["review.compose"].tap()
        let text = app.textFields["review.text"].exists ? app.textFields["review.text"] : app.textViews["review.text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.typeText("Keep the window bounded by bytes, not entries.")
        capture("composer")
        app.buttons["review.save"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["review.comment"].waitForExistence(timeout: 15))
        capture("draft")
        app.buttons["review.sendAll"].tap()
        XCTAssertTrue(app.staticTexts["Sent"].waitForExistence(timeout: 20))
        capture("sent")

        app.buttons["review.list"].tap()
        XCTAssertTrue(app.buttons["review.approve"].waitForExistence(timeout: 10))
        app.buttons["review.approve"].tap()
        XCTAssertTrue(app.staticTexts["Review · Approved"].waitForExistence(timeout: 15))
        capture("approved")
        app.buttons["Done"].firstMatch.tap()

        let viewed = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.reviewed.'")).firstMatch
        XCTAssertTrue(viewed.waitForExistence(timeout: 10)); viewed.tap()
        XCTAssertTrue(viewed.isSelected || app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.reviewed.' AND selected == true")).firstMatch.waitForExistence(timeout: 10))
        capture("viewed")
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
