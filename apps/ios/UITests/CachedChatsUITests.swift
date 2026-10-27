import XCTest

/// The phone's cached chats against the spike fixture (ADR 0105): a thread reloads from its
/// machine from the ⋯ menu, and Settings shows what is kept and clears it. Run on a fresh fixture;
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class CachedChatsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testAThreadReloadsFromItsMachineAndSettingsClearsWhatIsKept() {
        // Opening the finished thread keeps it on the phone.
        var app = launch(["--spike-open", "ios-done"])
        let message = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Dynamic Type")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 30))

        // Reload from machine: the transcript is read again and shown in place.
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        let reload = app.threadMenuItem("thread.reload")
        XCTAssertTrue(reload.waitForExistence(timeout: 5))
        screenshot("cache-thread-menu")
        reload.tap()
        XCTAssertTrue(message.waitForExistence(timeout: 30))
        screenshot("cache-thread-reloaded")
        // Kept copies are written at most once a second.
        Thread.sleep(forTimeInterval: 2)
        app.terminate()

        // Settings → Cached chats: what is kept, then cleared.
        app = launch([])
        let settings = app.buttons["inbox.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        settings.tap()
        let cache = app.buttons["settings.cache"]
        XCTAssertTrue(cache.waitForExistence(timeout: 10))
        cache.tap()
        let total = element(app, "cache.total")
        XCTAssertTrue(total.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(total, contains: "1 chat"), total.label)
        screenshot("cache-settings")

        app.buttons["cache.clearAll"].tap()
        let confirm = app.buttons["cache.clearAll.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("cache-settings-confirm")
        confirm.tap()
        XCTAssertTrue(waitFor(total, contains: "0 chats"), total.label)
        screenshot("cache-settings-cleared")
    }

    private func launch(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"] + extra
        app.launch()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if alert.waitForExistence(timeout: 5) { alert.tap() }
        return app
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func waitFor(_ element: XCUIElement, contains text: String, timeout: TimeInterval = 15) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS %@", text)
        return XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: timeout) == .completed
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
