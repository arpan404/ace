import XCTest

/// Needs a fresh install (so the permission prompt shows) and a fresh spike fixture.
@MainActor final class NotificationUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    func testPermissionAfterFirstThreadThenLiveAlertDeepLinkAndCatchUp() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        app.revealRow("thread.ios-approval")
        // Asked once the first thread arrives, not at launch.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = springboard.alerts.buttons["Allow"]
        XCTAssertTrue(permission.waitForExistence(timeout: 25))
        permission.tap()

        // A daemon alert shows as a banner; tapping it opens the thread.
        try await notify(["threadId": "ios-done", "id": "ui:done"])
        let done = banner(springboard, "Tighten the composer spacing")
        XCTAssertTrue(done.waitForExistence(timeout: 15))
        attach("banner", XCUIScreen.main)
        done.tap()
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.waitForExistence(timeout: 10))
        attach("deep-link", app)
        app.navigationBars.buttons.firstMatch.tap()

        // Missed while disconnected: the alert arrives from catch-up once the app reconnects.
        try await post("control", ["online": false])
        try await notify(["threadId": "ios-tree", "id": "ui:missed"])
        try await post("control", ["online": true])
        let missed = banner(springboard, "Review PID-reuse safety")
        XCTAssertTrue(missed.waitForExistence(timeout: 30))
        attach("catch-up", XCUIScreen.main)
    }
    private func post(_ path: String, _ body: [String: Bool]) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/\(path)")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await URLSession.shared.data(for: request)
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
