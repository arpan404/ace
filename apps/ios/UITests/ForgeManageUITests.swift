import XCTest

/// Managing pull requests on the spike fixture (`bun run spike:daemon`): #233 in acme/ace sits in
/// a milestone and closes #240. `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a
/// folder) also saves screenshots.
@MainActor final class ForgeManageUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLockingTheConversationShowsItLocked() {
        let app = launchOnPulls()
        open(app, "forge.pull.233")
        let lock = app.buttons["forge.manage.lock"]
        app.reveal(lock)
        screenshot("manage")
        lock.tap()
        let reason = app.buttons["Resolved"]
        XCTAssertTrue(reason.waitForExistence(timeout: 10))
        reason.tap()
        XCTAssertTrue(app.buttons["forge.manage.unlock"].waitForExistence(timeout: 20))
        screenshot("manage-locked")
    }

    func testAMergeOpensItsCommitToEditFirst() {
        let app = launchOnPulls()
        open(app, "forge.pull.233")
        let primary = app.buttons["forge.pull.primary"]
        XCTAssertTrue(primary.waitForExistence(timeout: 20))
        guard primary.isEnabled else { return }
        primary.tap()
        XCTAssertTrue(app.textFields["forge.commit.title"].waitForExistence(timeout: 10))
        screenshot("merge-commit")
    }

    func testANewPullRequestOpensFromABranch() {
        let app = launchOnPulls()
        let new = app.buttons["forge.newpr"]
        XCTAssertTrue(new.waitForExistence(timeout: 20))
        new.tap()
        let head = app.buttons["forge.newpr.head"]
        XCTAssertTrue(head.waitForExistence(timeout: 20))
        head.tap()
        let branch = app.buttons["feature/release-notes"]
        XCTAssertTrue(branch.waitForExistence(timeout: 10))
        branch.tap()
        let create = app.buttons["forge.newpr.create"]
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: create)
        wait(for: [enabled], timeout: 20)
        screenshot("new-pull")
        create.tap()
        XCTAssertTrue(app.descendants(matching: .any)["forge.pull.header"].firstMatch.waitForExistence(timeout: 20))
    }

    func testACommentFromTheIssuePageJoinsItsConversation() {
        let app = launchOnPulls()
        let segment = app.buttons["forge.kind.issues"]
        XCTAssertTrue(segment.waitForExistence(timeout: 20))
        segment.tap()
        let row = app.buttons["forge.issue.240"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        let box = app.textFields["forge.editor"].firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 20))
        app.reveal(box)
        box.tap()
        box.typeText("Seen on the phone too.")
        app.buttons["forge.issue.comment"].tap()
        XCTAssertTrue(app.staticTexts["Seen on the phone too."].waitForExistence(timeout: 20))
        screenshot("issue-commented")
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
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-forge-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("forge-\(name).png"))
        }
    }
}
