import XCTest

@MainActor final class SpikeUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testManyLargeApprovalActionsStayVisibleAndSelectable() async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:9841/review/many")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(ManyScenario(id: "ios-many-menu"))
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-many-menu"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-many-menu"].tap()
        XCTAssertTrue(app.buttons["approval.more"].waitForExistence(timeout: 25))
        screenshot("many-approval")
        app.buttons["approval.more"].tap()
        XCTAssertTrue(app.buttons["Choice 2"].waitForExistence(timeout: 10))
        app.buttons["Choice 2"].tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["approval.more"])
        await fulfillment(of: [closed], timeout: 15)
    }
    func testInboxThreadAndApprovalScreens() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForExistence(timeout: 25))
        screenshot("inbox")
        app.buttons["thread.ios-approval"].tap()
        XCTAssertTrue(app.buttons["approval.allow_once"].waitForExistence(timeout: 10))
        screenshot("approval")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["thread.ios-stream"].tap()
        XCTAssertTrue(app.staticTexts["spike.loaded"].waitForExistence(timeout: 25))
        let loaded = NSPredicate(format: "value == '2000'")
        expectation(for: loaded, evaluatedWith: app.staticTexts["spike.loaded"])
        waitForExpectations(timeout: 25)
        screenshot("thread")
    }
    func testScrollWhileTwoThousandItemsStream() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        let loaded = NSPredicate(format: "value == '2000'")
        expectation(for: loaded, evaluatedWith: app.staticTexts["spike.loaded"])
        waitForExpectations(timeout: 25)
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTMemoryMetric(application: app)], options: options) {
            app.collectionViews.firstMatch.swipeDown(velocity: .fast)
            app.collectionViews.firstMatch.swipeDown(velocity: .fast)
            app.collectionViews.firstMatch.swipeUp(velocity: .fast)
        }
    }
    func testTypingWhileStreaming() async throws {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        let loaded = NSPredicate(format: "value == '2000'")
        let ready = expectation(for: loaded, evaluatedWith: app.staticTexts["spike.loaded"])
        await fulfillment(of: [ready], timeout: 25)
        let field = app.textViews["composer.input"]
        field.tap()
        field.typeText("Keep process ownership explicit. Preserve every pending send through reconnect and restart. ")
        try await Task.sleep(for: .seconds(6))
        screenshot("typing")
    }
    func testOfflineSendSurvivesProcessTerminationAndReplaysOnce() async throws {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        XCTAssertTrue(app.textViews["composer.input"].waitForExistence(timeout: 25))
        let ready = expectation(for: NSPredicate(format: "value IN {'2000', '2001', '2002'}"), evaluatedWith: app.staticTexts["spike.loaded"])
        await fulfillment(of: [ready], timeout: 25)
        try await control(false)
        let text = "Offline simulator send \(UUID().uuidString)"
        app.textViews["composer.input"].tap()
        app.textViews["composer.input"].typeText(text)
        app.buttons["composer.send"].tap()
        XCTAssertTrue(app.staticTexts["Sends on reconnect"].waitForExistence(timeout: 10))
        screenshot("offline")
        app.terminate()
        try await control(true)
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        let request = try XCTUnwrap(URL(string: "http://127.0.0.1:9841/state"))
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(15))
        var count = 0
        repeat {
            let (data, _) = try await URLSession.shared.data(from: request)
            let state = try JSONDecoder().decode(TranscriptState.self, from: data)
            count = state.items.values.filter { $0.parts?.contains { $0.text == text } == true }.count
            if count == 0 { try await Task.sleep(for: .milliseconds(100)) }
        } while count == 0 && clock.now < deadline
        XCTAssertEqual(count, 1)
    }
    func testTwoMinuteStreamingMemoryWindow() {
        let app = launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        expectation(for: NSPredicate(format: "value == '2000'"), evaluatedWith: app.staticTexts["spike.loaded"])
        waitForExpectations(timeout: 25)
        // Leave the real app streaming without accessibility snapshots during the measured window.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 60))
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 60))
        XCTAssertEqual(app.staticTexts["spike.loaded"].value as? String, "2000")
        screenshot("memory-window")
    }
    func testAdmittedSendWithLostReceiptSurvivesTerminationAndReplaysOnce() async throws {
        let text = "Lost receipt simulator send \(UUID().uuidString)"
        var arm = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:9841/review/receipt")))
        arm.httpMethod = "POST"
        arm.httpBody = try JSONEncoder().encode(ReceiptScenario(text: text))
        let (_, response) = try await URLSession.shared.data(for: arm)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = launch()
        // Restore the fixture even if an assertion aborts the scenario.
        defer { app.terminate(); Task { try? await control(true) } }
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        app.buttons["thread.ios-stream"].tap()
        XCTAssertTrue(app.textViews["composer.input"].waitForExistence(timeout: 25))
        app.textViews["composer.input"].tap()
        app.textViews["composer.input"].typeText(text)
        app.buttons["composer.send"].tap()
        _ = try await waitForReceipt { $0.dropped == 1 }
        // Admission precedes the missing receipt and process kill.
        let admitted = try await inputCount(text)
        XCTAssertEqual(admitted, 1)
        app.terminate()
        try await control(true)
        app.launch()
        XCTAssertTrue(app.buttons["thread.ios-stream"].waitForExistence(timeout: 25))
        let replay = try await waitForReceipt { $0.delivered >= 1 }
        XCTAssertGreaterThanOrEqual(replay.attempts, 2)
        XCTAssertEqual(replay.dropped, 1)
        let restored = try await inputCount(text)
        XCTAssertEqual(restored, 1)
    }
    private func waitForReceipt(_ condition: (ReceiptState) -> Bool) async throws -> ReceiptState {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:9841/review/receipt"))
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(25))
        repeat {
            let (data, _) = try await URLSession.shared.data(from: url)
            let state = try JSONDecoder().decode(ReceiptState.self, from: data)
            if condition(state) { return state }
            try await Task.sleep(for: .milliseconds(100))
        } while clock.now < deadline
        throw ReceiptError.timeout
    }
    private func inputCount(_ text: String) async throws -> Int {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:9841/state"))
        let (data, _) = try await URLSession.shared.data(from: url)
        let state = try JSONDecoder().decode(TranscriptState.self, from: data)
        return state.items.values.filter { $0.parts?.contains { $0.text == text } == true }.count
    }
    private func control(_ online: Bool) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:9841/control")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(OnlineControl(online: online))
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike"]
        app.launch()
        return app
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private struct OnlineControl: Encodable { let online: Bool }
private struct ManyScenario: Encodable { let id: String }
private struct ReceiptScenario: Encodable { let text: String }
private struct ReceiptState: Decodable { let attempts: Int; let dropped: Int; let delivered: Int }
private enum ReceiptError: Error { case timeout }
private struct TranscriptState: Decodable {
    struct Entry: Decodable { struct Part: Decodable { let text: String? }; let parts: [Part]? }
    let items: [String: Entry]
}
