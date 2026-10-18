import XCTest

/// Two fixture machines in one inbox. Run two separate-host fixtures first:
/// `ACE_IOS_SPIKE_PORT=9852 ACE_IOS_SPIKE_MACHINE=1 bun run spike:daemon`, and the same on 9863.
/// Both seed the same thread ids, so every row must stay tied to its own machine.
@MainActor final class MachinesUITests: XCTestCase, @unchecked Sendable {
    private let ports = [9852, 9863]
    override func setUp() { continueAfterFailure = false }

    func testTwoMachinesShareOneInboxAndOneGoingOfflineLeavesTheOther() async throws {
        try await control(9863, online: true)
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-machines", ports.map(String.init).joined(separator: ",")]
        app.launch()
        defer { app.terminate() }
        let first = app.buttons["thread.ios-spike-host-9852.ios-stream"]
        let second = app.buttons["thread.ios-spike-host-9863.ios-stream"]
        XCTAssertTrue(first.waitForExistence(timeout: 30))
        XCTAssertTrue(second.waitForExistence(timeout: 30))
        XCTAssertTrue(first.label.contains("studio-9852") && second.label.contains("studio-9863"), "rows name their machine")
        screenshot("machines-inbox")

        // Opening a row routes to its own machine's runtime and transcript.
        second.tap()
        XCTAssertTrue(app.otherElements["spike.loaded"].waitForExistence(timeout: 30) || app.collectionViews["transcript"].waitForExistence(timeout: 5))
        screenshot("machines-thread")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))

        app.buttons["inbox.machines"].tap()
        screenshot("machines-sheet-opening")
        XCTAssertTrue(app.descendants(matching: .any)["machines.row.ios-spike-host-9852"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["machines.row.ios-spike-host-9863"].firstMatch.exists)
        screenshot("machines-sheet")
        app.descendants(matching: .any)["machines.row.ios-spike-host-9852"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["provider.codex"].firstMatch.waitForExistence(timeout: 20))
        screenshot("machines-detail")
        app.navigationBars["studio-9852"].buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["Done"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))

        // One machine drops: its banner appears, the other machine's rows stay and stay live.
        try await control(9863, online: false)
        defer { Task { try? await self.control(9863, online: true) } }
        let banner = app.descendants(matching: .any)["inbox.connection.studio-9863"].firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 20))
        XCTAssertTrue(first.exists)
        XCTAssertFalse(app.descendants(matching: .any)["inbox.connection.studio-9852"].firstMatch.exists)
        screenshot("machines-one-offline")
        try await control(9863, online: true)
        let back = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: banner)
        await fulfillment(of: [back], timeout: 30)
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
