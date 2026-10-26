import XCTest

/// Scroll to end lands on the newest rows, drawn, wherever the person was reading: never on an
/// empty stretch past or before them, and following the end keeps it in view. Runs against the spike fixture;
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class TranscriptEndUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testScrollToEndAfterReadingFarBackShowsTheNewestMessage() {
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(newest(in: app).waitForExistence(timeout: 30))
        // Far enough back that the history window opens and slides older.
        for _ in 0..<40 { transcript.fling(older: true) }
        XCTAssertEqual(transcript.value as? String, "Reading history")
        app.buttons["Scroll to end"].tap()
        assertAtTheEnd(app, "after reading far back")
    }

    func testScrollToEndAfterReadingAFewScreensUpShowsTheNewestMessage() {
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(newest(in: app).waitForExistence(timeout: 30))
        for _ in 0..<3 { transcript.fling(older: true) }
        let jump = app.buttons["Scroll to end"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        jump.tap()
        assertAtTheEnd(app, "after reading a few screens up")
    }

    /// Following the live end while the agent runs tools in bursts, each ending in a few lines:
    /// the newest lines stay drawn just above the composer, never scrolled off into empty space.
    func testFollowingTheEndThroughToolBurstsKeepsTheNewestLinesInView() throws {
        let app = open("ios-burst")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        let composer = app.textViews["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        // Enough work first that the thread is taller than the screen: a short one starts at the top.
        for _ in 0..<4 { _ = try sendBurst() }
        sleep(2)
        for round in 0..<6 {
            let burst = try sendBurst()
            let note = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Burst \(burst):")).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 5), "burst \(burst) arrived")
            sleep(1)
            XCTAssertTrue(note.isHittable, "burst \(burst)'s lines are on screen (round \(round))")
            // Its last line sits just above the composer: the feed follows the end, not past it.
            XCTAssertLessThan(composer.frame.minY - note.frame.maxY, 260, "the newest lines are at the end of the feed (round \(round))")
        }
        screenshot("tool-bursts-followed")
    }
    /// While the agent works, the connection drops and comes back, and the app goes to the
    /// background and returns (a locked phone, another app): the transcript stays on screen
    /// throughout, never the loading placeholder or an empty feed, and still ends at the newest lines.
    func testTheTranscriptStaysOnScreenThroughReconnectsWhileTheAgentWorks() throws {
        let app = open("ios-burst")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        for _ in 0..<4 { _ = try sendBurst() }
        sleep(2)
        var blank: [String] = []
        func watch(_ seconds: TimeInterval, _ phase: String) {
            let until = Date().addingTimeInterval(seconds)
            while Date() < until {
                if (transcript.value as? String) == "Loading" { blank.append("\(phase): loading") }
                RunLoop.current.run(until: Date().addingTimeInterval(1))
            }
        }
        _ = try sendBurst()
        try setOnline(false)
        watch(3, "offline")
        try setOnline(true)
        _ = try sendBurst()
        watch(6, "reconnected")
        XCUIDevice.shared.press(.home)
        sleep(4)
        let burst = try sendBurst()
        app.activate()
        watch(6, "foreground")
        XCTAssertEqual(blank, [], "the transcript never went back to loading")
        let note = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Burst \(burst):")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 10), "the burst sent while away arrived")
        XCTAssertTrue(note.isHittable, "and it is on screen at the end of the feed")
        screenshot("reconnected-while-working")
    }
    private func setOnline(_ online: Bool) throws {
        try post("/control", #"{"online":\#(online)}"#)
    }
    /// Asks the fixture for a burst of 30 tool calls on ios-burst; its number.
    private func sendBurst() throws -> Int {
        try XCTUnwrap(try post("/review/burst", #"{"size":30}"#)["burst"] as? Int)
    }
    /// POSTs `body` to the fixture's `path`; its JSON reply.
    @discardableResult private func post(_ path: String, _ body: String) throws -> [String: Any] {
        let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)\(path)")))
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        var reply: [String: Any] = [:]
        let done = expectation(description: "fixture answered \(path)")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { reply = json }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return reply
    }
    /// The live end is drawn and on screen within a moment, and stays there.
    private func assertAtTheEnd(_ app: XCUIApplication, _ when: String) {
        let transcript = app.scrollViews["transcript"]
        let ready = expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: transcript)
        wait(for: [ready], timeout: 10)
        let message = newest(in: app)
        let shown = expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: message)
        wait(for: [shown], timeout: 3)
        screenshot("scroll-to-end-\(name)")
        // Still there once the rows above have measured themselves.
        sleep(1)
        XCTAssertTrue(message.isHittable, "the newest message stays on screen \(when)")
        XCTAssertFalse(app.buttons["Scroll to end"].exists, "Scroll to end goes once the end is in view \(when)")
    }
    /// The caret after the answer streaming at the live end: the newest thing in the thread.
    private func newest(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Streaming")).firstMatch
    }
    private func open(_ threadId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "--spike-open", threadId]
        app.launch()
        // The fixture build asks for notifications on first launch.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        return app
    }
    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
