import XCTest

/// The New thread sheet against the spike fixture: the choices as pills, the words, the
/// suggestions, and a start that closes into its thread. `ACE_IOS_SHOTS` keeps the screenshots.
@MainActor final class NewThreadSheetUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheSheetOpensOnTheWordsWithTheChoicesAboveThem() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["newThread.agent"].waitForExistence(timeout: 15))
        screenshot("sheet-empty")
        let message = app.descendants(matching: .any)["newThread.message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        // The keyboard is up at once: typing goes straight into the words.
        app.typeText("The Fleet map wires overlap when two machines share a network. Give each one its own lane")
        screenshot("sheet-typed")
        app.buttons["newThread.project"].tap()
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@", "project.", "project.chat")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        screenshot("sheet-projects")
        project.tap()
        XCTAssertTrue(app.buttons["newThread.worktree"].waitForExistence(timeout: 10))
        screenshot("sheet-project")
        app.buttons["newThread.worktree"].tap()
        screenshot("sheet-where-menu")
        app.buttons["New worktree"].firstMatch.tap()
        // The menu folds back into its pill; the pill names its new place once it has settled.
        let settled = app.buttons.matching(NSPredicate(format: "identifier == %@ AND value BEGINSWITH %@", "newThread.worktree", "Worktree")).firstMatch
        XCTAssertTrue(settled.waitForExistence(timeout: 10))
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "menu folds away")], timeout: 1)
        screenshot("sheet-worktree")
        if app.buttons["newThread.skills"].waitForExistence(timeout: 5) {
            app.buttons["newThread.skills"].tap()
            screenshot("sheet-skills-list")
        }
    }

    func testStartingSendsExactlyTheWordsInTheFieldAndOpensTheThread() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        let start = app.buttons["newThread.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 15))
        // A fresh launch opens on an empty field: nothing from an earlier run is waiting in it.
        let message = app.descendants(matching: .any)["newThread.message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertEqual((message.value as? String) ?? "", "")
        app.buttons["newThread.project"].tap()
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND identifier != %@", "project.", "project.chat")).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        message.tap()
        app.typeText("Tidy the release notes")
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: start)
        waitForExpectations(timeout: 20)
        start.tap()
        // The sheet closes once the start is saved, and the new thread opens on those words alone.
        XCTAssertTrue(app.buttons["newThread.start"].waitForNonExistence(timeout: 15))
        let sent = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Tidy the release notes")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 20))
        screenshot("after-start")
    }

    func testPlusMicAndSendAnswerAFullTouchTarget() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.start"].waitForExistence(timeout: 15))
        for identifier in ["newThread.attach", "newThread.mic", "newThread.start"] {
            let control = app.descendants(matching: .any)[identifier].firstMatch
            guard control.waitForExistence(timeout: 5) else { continue }
            XCTAssertGreaterThanOrEqual(control.frame.width, 44, identifier)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44, identifier)
        }
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        return app
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-newthread-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
