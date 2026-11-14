import XCTest

/// The Changes sheet against the fixture's `ios-changes` thread (`scripts/changes-scenario.ts`):
/// turn scopes, expand all, the file tree, paging a 22,000-line file, a line comment sent to the
/// agent, approving, and viewed marks with the review bar's count of them. `ACE_IOS_SHOTS` keeps each screen as a PNG.
@MainActor final class ChangesReviewUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testScopesTreePagingAndALineCommentGoToTheAgent() {
        let app = launch()
        openChanges(app)

        // The sheet opens on the last turn, with every scope in the title's menu.
        let scope = app.buttons["changes.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 20))
        wait(for: [expectation(for: NSPredicate(format: "label CONTAINS 'Last turn'"), evaluatedWith: scope)], timeout: 20)
        XCTAssertTrue(app.buttons["changes.file.apps/server/src/replay/window.test.ts"].waitForExistence(timeout: 20))
        // A turn takes no comments (a tapped line opens the file on Uncommitted), but the bar
        // still counts the files viewed.
        XCTAssertTrue(app.descendants(matching: .any)["review.progress"].waitForExistence(timeout: 10))
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

        // A comment on a line of the first file, sent to the agent. Deep in the paged diff the
        // pinned bar's Collapse all is still on screen; tap it where it is drawn.
        tapInPlace(app, expandAll(app))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == 'Expand all'")).firstMatch.waitForExistence(timeout: 10), "every file closed")
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
        // In a sheet the bar sends the comment. On a phone's thread page it rides on the next
        // message instead: the composer's chip carries it and Send, with no words, sends it.
        let sendAll = app.buttons["review.sendAll"]
        if sendAll.waitForExistence(timeout: 3) {
            sendAll.tap()
        } else {
            let chip = app.buttons["composer.comments"]
            XCTAssertTrue(chip.waitForExistence(timeout: 10), "the comment waits on the composer's chip")
            app.buttons["composer.send"].tap()
            let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: chip)
            wait(for: [gone], timeout: 20)
            let changesPage = app.buttons["thread.page.changes"]
            if changesPage.exists, !changesPage.isSelected { changesPage.tap() }
        }
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

        // Viewed marks are kept on the phone between runs: mark one that isn't viewed yet, from
        // its long-press menu (the swipe is checked on its own below).
        let progress = app.descendants(matching: .any)["review.progress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        let before = viewedCount(progress.label)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.' AND NOT (value CONTAINS 'Viewed')"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        // The list is lazy and long, and a row scrolled under the pinned bar still reads as
        // hittable: press only a row clear of both bars, bringing one into the open if none is.
        var picked = clearRow(app, in: rows)
        for _ in 0..<3 where picked == nil {
            app.bringToMiddle(rows.firstMatch)
            picked = clearRow(app, in: rows)
        }
        guard let row = picked else { return XCTFail("no unviewed file row clear of the bars to press") }
        let id = row.identifier
        row.press(forDuration: 1.0)
        let mark = app.buttons.matching(NSPredicate(format: "label == 'Mark as viewed'")).firstMatch
        XCTAssertTrue(mark.waitForExistence(timeout: 5)); mark.tap()
        let viewed = expectation(for: NSPredicate(format: "value CONTAINS 'Viewed'"), evaluatedWith: app.buttons[id])
        wait(for: [viewed], timeout: 10)
        // The review bar counts it.
        let counted = expectation(for: NSPredicate(format: "label BEGINSWITH %@", "\(before + 1) of "), evaluatedWith: progress)
        wait(for: [counted], timeout: 10)
        let after = progress.label
        capture("viewed")

        // Leaving Changes and coming back keeps the mark and the count: on a phone Changes is a
        // page beside Chat, elsewhere a sheet.
        let chat = app.buttons["thread.page.chat"]
        if chat.exists {
            chat.tap()
            XCTAssertTrue(app.scrollViews["transcript"].waitForExistence(timeout: 10))
            app.buttons["thread.page.changes"].tap()
        } else {
            app.buttons["changes.close"].tap()
            XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 10))
            app.buttons["thread.menu"].tap()
            let again = app.threadMenuItem("thread.changes")
            XCTAssertTrue(again.waitForExistence(timeout: 10)); again.tap()
        }
        // The mark was made on Uncommitted; a fresh sheet opens on the last turn.
        XCTAssertTrue(scope.waitForExistence(timeout: 20))
        if !scope.label.contains("Uncommitted") {
            scope.tap()
            XCTAssertTrue(app.buttons["Uncommitted"].waitForExistence(timeout: 5)); app.buttons["Uncommitted"].tap()
            wait(for: [expectation(for: NSPredicate(format: "label CONTAINS 'Uncommitted'"), evaluatedWith: scope)], timeout: 20)
        }
        let reopened = app.descendants(matching: .any)["review.progress"]
        XCTAssertTrue(reopened.waitForExistence(timeout: 20))
        wait(for: [expectation(for: NSPredicate(format: "label == %@", after), evaluatedWith: reopened)], timeout: 20)
        capture("viewed-reopened")
    }

    /// On a phone Changes is a page beside Chat: a sideways swipe on a file's header must mark it,
    /// not be taken by the swipe between the pages.
    func testSwipingAFileHeaderMarksItViewed() {
        let app = launch()
        openChanges(app)
        let scope = app.buttons["changes.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 20))
        if !scope.label.contains("Uncommitted") {
            scope.tap()
            XCTAssertTrue(app.buttons["Uncommitted"].waitForExistence(timeout: 5)); app.buttons["Uncommitted"].tap()
            wait(for: [expectation(for: NSPredicate(format: "label CONTAINS 'Uncommitted'"), evaluatedWith: scope)], timeout: 20)
        }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'changes.file.' AND NOT (value CONTAINS 'Viewed')"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        guard let row = rows.allElementsBoundByIndex.first(where: { $0.isHittable }) else {
            return XCTFail("no unviewed file on screen to swipe")
        }
        let id = row.identifier
        row.swipeLeft()
        let viewed = expectation(for: NSPredicate(format: "value CONTAINS 'Viewed'"), evaluatedWith: app.buttons[id])
        wait(for: [viewed], timeout: 10)
        XCTAssertTrue(app.buttons["changes.scope"].exists, "the swipe stayed on Changes")
        capture("swiped-viewed")
    }

    /// The fixture's `ios-changes` thread opened at launch, then its Changes.
    private func openChanges(_ app: XCUIApplication) {
        let page = app.buttons["thread.page.changes"]
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 30), "the thread opens at launch")
        if page.waitForExistence(timeout: 5) { page.tap(); return }
        menu.tap()
        let changes = app.threadMenuItem("thread.changes")
        XCTAssertTrue(changes.waitForExistence(timeout: 10)); changes.tap()
    }

    /// "3 of 7 files viewed" → 3.
    private func viewedCount(_ label: String) -> Int {
        Int(label.split(separator: " ").first ?? "") ?? -1
    }

    /// The first of `rows` drawn wholly between the pinned top bar (the scope and Collapse all)
    /// and the review bar at the foot, where a press lands on the row itself.
    private func clearRow(_ app: XCUIApplication, in rows: XCUIElementQuery) -> XCUIElement? {
        let pinned = [app.buttons["changes.scope"], expandAll(app)].filter(\.exists).map(\.frame.maxY).max() ?? 0
        let progress = app.descendants(matching: .any)["review.progress"]
        let foot = progress.exists ? progress.frame.minY : app.frame.maxY * 0.85
        return rows.allElementsBoundByIndex.first { row in
            let frame = row.frame
            return row.isHittable && frame.minY > pinned + 4 && frame.maxY < foot - 4
        }
    }
    /// Tap a control once it is hittable; a control drawn on screen whose hit point XCTest
    /// can't work out (a bar pinned over a scrolled page) is tapped at its frame instead.
    private func tapInPlace(_ app: XCUIApplication, _ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        let hittable = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: element)
        if XCTWaiter.wait(for: [hittable], timeout: 5) == .completed { element.tap(); return }
        let frame = element.frame
        XCTAssertFalse(frame.isEmpty, "\(element.identifier) is drawn")
        XCTAssertTrue(app.frame.contains(CGPoint(x: frame.midX, y: frame.midY)), "\(element.identifier) is on screen: \(frame)")
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    /// Expand all or Collapse all, whichever the row shows.
    private func expandAll(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == 'changes.expand' OR label == 'Expand all' OR label == 'Collapse all'")).firstMatch
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-open", "ios-changes"]
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
