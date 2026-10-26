import XCTest

/// The thread composer's `@`, `/` and + lists against the spike fixture, with screenshots. Run on
/// a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ComposerSuggestionsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testMentionsCommandsAndTheAddListInAThread() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if alert.waitForExistence(timeout: 5) { alert.tap() }
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        input.tap()

        // `@` lists files; typing narrows them; picking inserts the file's reference.
        input.typeText("Look at @")
        let list = app.descendants(matching: .any)["composer.suggestions"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        input.typeText("READ")
        let readme = app.buttons["composer.suggestion.file:README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        screenshot("composer-mention")
        readme.tap()
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Look at @README.md ")

        // `/` lists the catalog.
        input.typeText("/")
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "composer.suggestion.entry:")).firstMatch
            .waitForExistence(timeout: 15))
        screenshot("composer-command")
        // Deleting the `/` closes it.
        input.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))

        // + offers the phone's sources and the catalog's builtins.
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.add.files"].waitForExistence(timeout: 10))
        screenshot("composer-add")
        app.buttons["composer.add.files"].tap()
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        screenshot("composer-add-files")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
