import XCTest

/// Usage over two fixture machines. Run two separate-host fixtures first:
/// `ACE_IOS_SPIKE_PORT=9921 ACE_IOS_SPIKE_MACHINE=1 bun run spike:daemon`, and the same on 9922.
/// The figures count both machines; one going offline is named, never dropped silently.
@MainActor final class UsageMachinesUITests: XCTestCase, @unchecked Sendable {
    private let ports = [9921, 9922]
    override func setUp() { continueAfterFailure = false }

    func testUsageCountsEveryMachineAndNamesOneThatGoesOffline() async throws {
        try await control(9922, online: true)
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-machines", ports.map(String.init).joined(separator: ",")]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["thread.ios-spike-host-9922.ios-approval"].waitForExistence(timeout: 30))
        app.openBrowseDestination("library.usage")

        let coverage = app.staticTexts["usage.coverage"]
        XCTAssertTrue(coverage.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["usage.machine"].exists)
        XCTAssertTrue(app.buttons["usage.refresh"].exists)
        // Slim capsules, but every filter and Refresh still takes a 44pt tap.
        XCTAssertGreaterThanOrEqual(app.buttons["usage.machine"].frame.height, 44)
        XCTAssertGreaterThanOrEqual(app.buttons["usage.refresh"].frame.height, 44)
        XCTAssertTrue(waitFor(coverage, label: "All 2 machines"))
        // Each account sits under the machine it was read on.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "studio-9921")).firstMatch.waitForExistence(timeout: 20))
        screenshot("usage-limits-machines")

        app.buttons["usage.refresh"].tap()
        XCTAssertTrue(app.buttons["Refresh"].waitForExistence(timeout: 30))
        XCTAssertTrue(waitFor(coverage, label: "All 2 machines"))

        app.buttons["Tokens"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["usage.total"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(waitFor(coverage, label: "All 2 machines"))
        screenshot("usage-tokens-machines")

        try await control(9922, online: false)
        XCTAssertTrue(waitFor(coverage, label: "1 of 2 machines · studio-9922 is offline", timeout: 30))
        screenshot("usage-tokens-offline")
        app.buttons["Limits"].tap()
        XCTAssertTrue(waitFor(coverage, label: "1 of 2 machines · studio-9922 is offline"))
        screenshot("usage-limits-offline")

        app.buttons["usage.machine"].tap()
        app.buttons["studio-9921"].tap()
        // One machine: its accounts no longer name it, and only its figures show.
        XCTAssertTrue(app.staticTexts["Max"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "studio-9922")).firstMatch.exists)
        screenshot("usage-limits-one-machine")
        try await control(9922, online: true)
    }

    private func waitFor(_ element: XCUIElement, label: String, timeout: TimeInterval = 20) -> Bool {
        let matched = expectation(for: NSPredicate(format: "label == %@", label), evaluatedWith: element)
        return XCTWaiter().wait(for: [matched], timeout: timeout) == .completed
    }
    private func control(_ port: Int, online: Bool) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/control")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(#"{"online":\#(online)}"#.utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
