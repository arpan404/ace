import XCTest

/// The work a pull request page starts, on the spike fixture (`bun run spike:daemon`, seeded by
/// `seedPrWork`): #229's checks (a failing `test (web)` with a long log, a running `e2e (ios)`),
/// #226's linked thread `pr-work-226` with conflicts against main and a stack with #224, and
/// merged #212's revert. The fixture keeps what each test changes, so run them on a fresh one.
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves screenshots.
@MainActor final class ForgePrWorkUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testAFailingCheckOpensOnItsLogAndReRunsItsFailedJobs() {
        let app = launchOnPulls()
        open(app, "forge.pull.229")
        tapRevealed(app, app.buttons["forge.check.test (web)"])
        let state = app.staticTexts["forge.check.state"]
        XCTAssertTrue(state.waitForExistence(timeout: 20))
        XCTAssertEqual(state.label, "Failed")
        XCTAssertTrue(app.descendants(matching: .any)["forge.log"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Error: expected the model chip'")).firstMatch.waitForExistence(timeout: 20))
        screenshot("check-failing")
        app.swipeDown()
        tapRevealed(app, app.buttons["forge.check.rerun-failed"])
        XCTAssertTrue(waitForLabel(state, "Running"))
        screenshot("check-rerun")
    }

    func testCancellingARunningCheckIsAskedFirst() {
        let app = launchOnPulls()
        open(app, "forge.pull.229")
        tapRevealed(app, app.buttons["forge.check.e2e (ios)"])
        tapRevealed(app, app.buttons["forge.check.cancel"])
        let confirm = app.buttons["Cancel run"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        screenshot("check-cancel-confirm")
        confirm.tap()
        XCTAssertTrue(waitForLabel(app.staticTexts["forge.check.state"], "Cancelled"))
    }

    func testTheLocalCheckRunsFromThePullRequestPage() {
        let app = launchOnPulls()
        open(app, "forge.pull.229")
        let action = app.buttons["forge.local.action"]
        tapRevealed(app, action)
        // The run is followed until it settles: it reads Stop while live, Run again after.
        XCTAssertTrue(waitForLabel(action, "Run again", timeout: 40))
        screenshot("local-check")
    }

    func testCheckingOutThePullRequestInItsThread() {
        let app = launchOnPulls()
        open(app, "forge.pull.226")
        tapRevealed(app, app.buttons["forge.work.checkout"])
        XCTAssertTrue(app.staticTexts["Checked out on refactor/composer-toolbar"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["forge.work.open"].exists)
        screenshot("work-checked-out")
    }

    func testConflictsResolveHunkByHunkThenFinish() {
        let app = launchOnPulls()
        open(app, "forge.pull.226")
        tapRevealed(app, app.buttons["forge.pull.conflicts"])
        tapRevealed(app, app.buttons["forge.conflicts.start"])
        let both = app.buttons["Both"].firstMatch
        XCTAssertTrue(both.waitForExistence(timeout: 20))
        screenshot("conflicts")
        both.tap()
        let theirs = app.buttons["Theirs"].firstMatch
        XCTAssertTrue(theirs.waitForExistence(timeout: 20))
        theirs.tap()
        tapRevealed(app, app.buttons["Take ours"].firstMatch)
        let finish = app.buttons["forge.conflicts.finish"]
        XCTAssertTrue(finish.waitForExistence(timeout: 20))
        XCTAssertTrue(waitFor(finish, "isEnabled == true"))
        finish.tap()
        XCTAssertTrue(app.staticTexts["Pushed the merge to refactor/composer-toolbar"].waitForExistence(timeout: 20))
        screenshot("conflicts-pushed")
    }

    func testTheStackRebasesLocallyThenOffersToPublish() {
        let app = launchOnPulls()
        open(app, "forge.pull.226")
        tapRevealed(app, app.buttons["forge.pull.stack"])
        XCTAssertTrue(app.buttons["forge.stack.layer.224"].waitForExistence(timeout: 20))
        screenshot("stack")
        tapRevealed(app, app.buttons["forge.stack.rebase"])
        let confirm = app.buttons["forge.stack.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        screenshot("stack-confirm")
        confirm.tap()
        XCTAssertTrue(waitForLabel(app.staticTexts["forge.stack.operation"], "Rebased, not pushed"))
        XCTAssertTrue(app.buttons["forge.stack.push"].waitForExistence(timeout: 10))
        screenshot("stack-rebased")
    }

    func testRevertingAMergedPullRequestOpensADraft() {
        let app = launchOnPulls()
        let filters = app.buttons["forge.filters"]
        XCTAssertTrue(filters.waitForExistence(timeout: 20))
        filters.tap()
        let merged = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Merged'")).firstMatch
        XCTAssertTrue(merged.waitForExistence(timeout: 10))
        merged.tap()
        open(app, "forge.pull.212")
        tapRevealed(app, app.buttons["forge.manage.revert"])
        let create = app.buttons["forge.revert.create"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        screenshot("revert-draft")
        create.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Open revert draft' AND identifier != 'forge.revert.create'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        let opened = app.buttons["forge.revert.open"]
        XCTAssertTrue(opened.waitForExistence(timeout: 20))
        screenshot("revert-opened")
        opened.tap()
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].firstMatch.waitForExistence(timeout: 20))
    }

    private func launchOnPulls() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        app.tabBars.buttons["Pulls"].firstMatch.tap()
        return app
    }
    private func open(_ app: XCUIApplication, _ row: String) {
        let button = app.buttons[row]
        XCTAssertTrue(button.waitForExistence(timeout: 25))
        app.reveal(button)
        button.tap()
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].firstMatch.waitForExistence(timeout: 20))
    }
    private func tapRevealed(_ app: XCUIApplication, _ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 25))
        app.reveal(element)
        element.tap()
    }
    private func waitFor(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 20) -> Bool {
        let done = expectation(for: NSPredicate(format: format), evaluatedWith: element)
        return XCTWaiter().wait(for: [done], timeout: timeout) == .completed
    }
    private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 20) -> Bool {
        waitFor(element, "label == '\(label)'", timeout: timeout)
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-forge-work-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("forge-work-\(name).png"))
        }
    }
}
