import XCTest

/// On a fresh install this answers the system prompt. A reused install must already allow alerts.
@MainActor final class NotificationUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    func testPermissionAfterFirstThreadThenLiveAlertDeepLinkAndCatchUp() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port, "-ace.inbox.openThread", "none"]
        app.launchWithArguments()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = springboard.alerts.buttons["Allow"]
        if permission.waitForExistence(timeout: 25) {
            permission.tap()
        } else {
            // Other fixture tests can have granted permission. Confirm alerts are already on
            // without enabling them here, so a missing first-time prompt still fails.
            app.openBrowseDestination("settings.notifications")
            let enabled = app.switches["notifications.enabled"]
            XCTAssertTrue(enabled.waitForExistence(timeout: 10))
            XCTAssertEqual(enabled.value as? String, "1", "expected a permission prompt or already enabled alerts")
            app.closeSheet()
            app.tabBars.buttons.matching(NSPredicate(format: "identifier == 'tab.threads' OR label == 'Projects'"))
                .firstMatch.tap()
        }
        app.revealRow("thread.ios-approval")

        // A daemon alert shows as a banner; tapping it opens the thread.
        let run = UUID().uuidString
        try await notify(["threadId": "ios-done", "id": "ui:done:\(run)"])
        let done = banner(springboard, "Tighten the composer spacing")
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        attach("banner", XCUIScreen.main)
        done.tap()
        XCTAssertTrue(app.threadTitle(named: "Tighten the composer spacing").waitForExistence(timeout: 10))
        attach("deep-link", app)
        app.tapBack()

        // Missed while disconnected: the alert arrives from catch-up once the app reconnects.
        try await post("control", ["online": false])
        try await notify(["threadId": "ios-tree", "id": "ui:missed:\(run)"])
        try await post("control", ["online": true])
        let missed = banner(springboard, "Review PID-reuse safety")
        XCTAssertTrue(missed.waitForExistence(timeout: 30))
        attach("catch-up", XCUIScreen.main)
    }
    private func post(_ path: String, _ body: [String: Bool]) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/\(path)")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func banner(_ springboard: XCUIApplication, _ text: String) -> XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    private func notify(_ body: [String: String]) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/review/notify")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    private func attach(_ name: String, _ source: XCUIScreenshotProviding) {
        let attachment = XCTAttachment(screenshot: source.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
