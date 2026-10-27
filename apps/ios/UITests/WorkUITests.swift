import XCTest

/// The thread's Work sheet and its problem line against the spike fixture. Each test asks the
/// fixture for a fresh thread (`POST /review/work`, `scripts/work-scenario.ts`), so they pass in
/// any order. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves each
/// screenshot there as `work-<name>.png`.
@MainActor final class WorkUITests: XCTestCase, @unchecked Sendable {
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    override func setUp() { continueAfterFailure = false }

    func testTheBranchLineOpensWorkAndSwitchesTheBranch() throws {
        let app = try open("clean")
        let subtitle = app.buttons["thread.subtitle"]
        XCTAssertTrue(subtitle.waitForExistence(timeout: 15))
        subtitle.tap()
        let branch = app.buttons["work.branch"]
        XCTAssertTrue(branch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["work.place.local"].exists)
        screenshot("sheet")
        branch.tap()
        let develop = app.buttons["work.branch.develop"]
        XCTAssertTrue(develop.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["work.branch.main"].isSelected, "the current branch is marked")
        screenshot("branches")
        let search = app.searchFields.firstMatch
        if search.waitForExistence(timeout: 3) {
            search.tap()
            search.typeText("dev")
            XCTAssertFalse(app.buttons["work.branch.main"].waitForExistence(timeout: 2), "search narrows the list")
        }
        develop.tap()
        let outcome = app.descendants(matching: .any)["work.outcome"]
        XCTAssertTrue(outcome.waitForExistence(timeout: 15))
        XCTAssertTrue(outcome.label.contains("Switched to develop"), outcome.label)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "work.branch", "develop")).firstMatch.waitForExistence(timeout: 10))
        screenshot("switched")
    }

    func testWorkFromTheMenuMovesTheCheckoutIntoAWorktree() throws {
        let app = try open("clean")
        app.buttons["thread.menu"].tap()
        let item = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "thread.work", "Work")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
        let move = app.buttons["work.move.worktree"]
        XCTAssertTrue(move.waitForExistence(timeout: 15))
        move.tap()
        XCTAssertTrue(app.buttons["work.move.local"].waitForExistence(timeout: 15), "once in a worktree, local is the way back")
        screenshot("worktree")
    }

    func testALinkedPullRequestOpensItsPageInTheApp() throws {
        let app = try open("clean")
        app.buttons["thread.subtitle"].tap()
        let pull = app.descendants(matching: .any)["work.pr.31"].firstMatch
        XCTAssertTrue(pull.waitForExistence(timeout: 15))
        pull.tap()
        XCTAssertTrue(app.navigationBars["#31"].waitForExistence(timeout: 15), "the pull request's own page is pushed, not GitHub")
        XCTAssertFalse(app.buttons["work.branch"].exists, "Work closed on the way")
        screenshot("pull-page")
    }

    func testLinkingAndUnlinkingAPullRequest() throws {
        let app = try open("clean")
        app.buttons["thread.subtitle"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["work.pr.31"].waitForExistence(timeout: 15))
        // The sheet opens at half height; Link a PR sits below the fold.
        let link = app.buttons["work.link"]
        app.reveal(link)
        link.tap()
        let field = app.textFields["work.link.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("#77")
        screenshot("link")
        app.buttons["work.link.submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["work.pr.77"].waitForExistence(timeout: 15))
        screenshot("linked")
        app.buttons["work.unlink.31"].tap()
        let confirm = app.buttons["work.unlink.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("unlink-confirm")
        confirm.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.descendants(matching: .any)["work.pr.31"])
        wait(for: [gone], timeout: 15)
        XCTAssertTrue(app.descendants(matching: .any)["work.pr.77"].exists, "only the one asked for goes")
    }

    func testAFailedSetupShowsInTheThreadAndContinuesWithoutIt() throws {
        let app = try open("stuck")
        let line = app.descendants(matching: .any)["thread.work"]
        XCTAssertTrue(line.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Setup script failed"].exists)
        screenshot("setup-line")
        // The same problem in Work, with the script's output.
        app.buttons["thread.subtitle"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["work.problem"].waitForExistence(timeout: 15))
        screenshot("setup-sheet")
        app.buttons["work.problem.setup-continue"].tap()
        let resolved = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.descendants(matching: .any)["work.problem"])
        wait(for: [resolved], timeout: 15)
        app.buttons["work.close"].tap()
        XCTAssertFalse(line.waitForExistence(timeout: 3), "the line goes once nothing stops the checkout")
    }

    func testAStaleLockIsClearedFromTheThreadAfterAsking() throws {
        let app = try open("locked")
        let clear = app.buttons["thread.work.lock.clear"]
        XCTAssertTrue(clear.waitForExistence(timeout: 15))
        screenshot("lock-line")
        clear.tap()
        let confirm = app.buttons["work.clearLock.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("lock-confirm")
        confirm.tap()
        let said = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Lock cleared")).firstMatch
        XCTAssertTrue(said.waitForExistence(timeout: 15))
        screenshot("lock-cleared")
    }

    func testWorkOffersClearingTheLockToo() throws {
        let app = try open("locked")
        XCTAssertTrue(app.buttons["thread.work.lock.clear"].waitForExistence(timeout: 15))
        app.buttons["thread.subtitle"].tap()
        XCTAssertTrue(app.buttons["work.clearLock"].waitForExistence(timeout: 15), "Work offers the same way out")
        screenshot("lock-sheet")
    }

    // MARK: - Fixture

    private func open(_ scenario: String) throws -> XCUIApplication {
        let threadId = try fresh(scenario)
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port, "--spike-open", threadId]
        app.launch()
        // The fixture build asks for notifications on first launch.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        return app
    }
    /// A new thread from the fixture for this test alone.
    private func fresh(_ scenario: String) throws -> String {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/review/work")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["scenario": scenario])
        let done = expectation(description: "fixture thread")
        let answer = Answer()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let body = try? JSONDecoder().decode([String: String].self, from: data) { answer.threadId = body["threadId"] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(answer.threadId, "the fixture made no \(scenario) thread")
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-work-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("work-\(name).png"))
        }
    }
}

/// The fixture's answer, written once by the request's callback before the test reads it.
private final class Answer: @unchecked Sendable { var threadId: String? }
