import XCTest

/// Settings › Keyboard and Settings › Notifications against the spike fixture (`bun run
/// spike:daemon`; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for another port, `TEST_RUNNER_ACE_IOS_SHOTS`
/// for a screenshot folder).
@MainActor final class KeyboardNotificationSettingsUITests: XCTestCase, @unchecked Sendable {
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }
    override func setUp() { continueAfterFailure = false }

    func testAClashingShortcutWaitsAndASavedOneShowsUntilResetAll() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        defer { app.terminate() }
        app.openBrowseDestination("settings.keyboard")
        let search = app.buttons["keyboard.shortcut.searchThreads"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        XCTAssertTrue(search.label.contains("⌘F"))
        XCTAssertTrue(app.descendants(matching: .any)["keyboard.returnSends"].exists, "Send with Return lives on this page")
        screenshot("keyboard")

        // ⌘N is New thread's: the editor names the clash and Save waits.
        search.tap()
        app.buttons["shortcut.key"].firstMatch.tap()
        let n = app.buttons["N"].firstMatch
        XCTAssertTrue(n.waitForExistence(timeout: 5))
        n.tap()
        let problem = app.staticTexts["shortcut.problem"]
        XCTAssertTrue(problem.waitForExistence(timeout: 5))
        XCTAssertTrue(problem.label.contains("New thread"), problem.label)
        XCTAssertFalse(app.buttons["shortcut.save"].isEnabled)
        screenshot("keyboard-clash")

        // ⇧⌘N is free: saved, and the list shows it as changed.
        flip(app.switches["shortcut.modifier.shift"].firstMatch)
        XCTAssertTrue(app.buttons["shortcut.save"].isEnabled)
        screenshot("keyboard-editor")
        app.buttons["shortcut.save"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertTrue(search.label.contains("⇧⌘N"), search.label)
        screenshot("keyboard-changed")

        // Reset all asks first, then brings back ⌘F.
        let reset = app.buttons["keyboard.resetAll"]
        for _ in 0..<3 where !reset.isHittable { app.swipeUp() }
        reset.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Reset all shortcuts")).element(boundBy: 1)
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertFalse(reset.waitForExistence(timeout: 2), "nothing is left to reset")
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertTrue(search.label.contains("⌘F") && !search.label.contains("⇧"), search.label)
    }

    func testThePhonesCategoriesAndQuietHoursShowUnderNotifications() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        defer { app.terminate() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.openBrowseDestination("settings.notifications")
        let enabled = app.switches["notifications.enabled"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 10))
        if enabled.value as? String != "1" {
            flip(enabled)
            let allow = springboard.alerts.buttons["Allow"]
            if allow.waitForExistence(timeout: 5) { allow.tap() }
        }
        let banners = app.switches["notifications.inApp.finished"]
        XCTAssertTrue(banners.waitForExistence(timeout: 10))
        XCTAssertTrue(banners.isEnabled, "categories are live once notifications are on")
        screenshot("notifications")

        let quiet = app.switches["notifications.phone.quiet"]
        for _ in 0..<3 where !quiet.isHittable { app.swipeUp() }
        if quiet.value as? String != "1" { flip(quiet) }
        let from = app.staticTexts["From"].firstMatch
        XCTAssertTrue(from.waitForExistence(timeout: 5), "quiet hours show their window")
        app.swipeUp()
        screenshot("notifications-quiet")
        flip(quiet)
        XCTAssertFalse(from.waitForExistence(timeout: 2))
    }

    /// A switch's knob: the inner switch where the system draws one, else the switch itself.
    private func flip(_ toggle: XCUIElement) {
        let inner = toggle.switches.firstMatch
        (inner.exists ? inner : toggle).tap()
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
