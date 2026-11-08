import XCTest

/// Scroll to end lands on the newest rows, drawn, wherever the person was reading: never on an
/// empty stretch past or before them, and following the end keeps it in view. Runs against the spike fixture;
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class TranscriptEndUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testReadingOlderMessagesStaysVisibleAndStillWhileTheTailStreams() {
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(newest(in: app).waitForExistence(timeout: 30))
        for _ in 0..<8 { transcript.fling(older: true) }
        XCTAssertTrue(app.descendants(matching: .any)["transcript.paging"].waitForNonExistence(timeout: 15))
        let frame = transcript.frame
        let visible = app.staticTexts.allElementsBoundByIndex.first {
            $0.isHittable && $0.label.count > 20 && $0.frame.maxY > frame.minY + 100 && $0.frame.minY < frame.maxY - 200
        }
        guard let visible else { return XCTFail("Reading history left an empty viewport") }
        let y = visible.frame.minY
        sleep(1) // The fixture keeps streaming while the person reads older messages.
        XCTAssertTrue(visible.isHittable, "Live updates must not replace the message being read")
        XCTAssertEqual(visible.frame.minY, y, accuracy: 4, "Reading position must stay still without another gesture")
    }

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

    /// Scrolled a little way up while the answer streams: Scroll to end shows above the composer
    /// and stays, still, through the streaming; tapping it reaches the end and it goes.
    func testScrollToEndShowsWhileScrolledUpAndStaysThroughTheStream() {
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        waitForReady(transcript)
        let jump = app.buttons["Scroll to end"]
        XCTAssertFalse(jump.exists, "no Scroll to end at the end")
        transcript.swipeDown()
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "scrolled up shows Scroll to end")
        let input = app.textViews["composer.input"]
        XCTAssertLessThanOrEqual(jump.frame.maxY, input.frame.minY, "it sits above the composer")
        let live = app.descendants(matching: .any)["composer.live"]
        if live.exists { XCTAssertLessThanOrEqual(jump.frame.maxY, live.frame.minY + 1, "and above the pills") }
        // The fixture keeps streaming: the button stays put the whole time.
        let place = jump.frame
        for _ in 0..<6 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            XCTAssertTrue(jump.exists, "Scroll to end stays while the tail streams")
            XCTAssertEqual(jump.frame.minY, place.minY, accuracy: 1, "and doesn't move")
        }
        screenshot("scrolled-up-streaming")
        jump.tap()
        assertEndInView(app, "after tapping it while streaming")
    }

    /// The keyboard coming and going leaves Scroll to end as it was: shown while reading up the
    /// transcript, above the composer as it rides the keyboard, and away at the end.
    func testScrollToEndStaysRightThroughTheKeyboard() {
        let app = open("ios-stream")
        let transcript = app.scrollViews["transcript"]
        waitForReady(transcript)
        let jump = app.buttons["Scroll to end"]
        let input = app.textViews["composer.input"]
        // At the end, the keyboard alone never brings it.
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertFalse(jump.exists, "the keyboard at the end doesn't offer Scroll to end")
        // Reading up: shown. The first drag may only put the keyboard away.
        for _ in 0..<3 where !jump.exists { transcript.swipeDown(); sleep(1) }
        XCTAssertTrue(jump.waitForExistence(timeout: 5))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertTrue(jump.exists, "the keyboard keeps Scroll to end while reading up")
        XCTAssertLessThanOrEqual(jump.frame.maxY, input.frame.minY, "above the composer on the keyboard")
        screenshot("scrolled-up-keyboard")
        // A tap on the transcript puts the keyboard away; the reader is still up the transcript.
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        sleep(1)
        XCTAssertTrue(jump.exists, "Scroll to end stays after the keyboard goes")
        jump.tap()
        assertEndInView(app, "after the keyboard came and went")
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
    /// The thread opened with its rows drawn at the live end.
    private func waitForReady(_ transcript: XCUIElement) {
        XCTAssertTrue(transcript.waitForExistence(timeout: 30))
        let ready = expectation(for: NSPredicate(format: "value == %@", "Ready"), evaluatedWith: transcript)
        wait(for: [ready], timeout: 30)
        sleep(1)
    }
    /// The streaming answer's end sits just above the composer and Scroll to end has gone.
    private func assertEndInView(_ app: XCUIApplication, _ when: String) {
        let jump = app.buttons["Scroll to end"]
        XCTAssertTrue(jump.waitForNonExistence(timeout: 5), "Scroll to end goes at the end \(when)")
        sleep(1)
        let answers = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.answer.ios-stream'"))
        XCTAssertTrue(answers.firstMatch.waitForExistence(timeout: 5), "the answer is drawn \(when)")
        let answer = answers.allElementsBoundByIndex.max { $0.frame.maxY < $1.frame.maxY }
        let input = app.textViews["composer.input"]
        guard let answer else { return XCTFail("no answer drawn \(when)") }
        XCTAssertLessThanOrEqual(answer.frame.maxY, input.frame.minY, "the end clears the composer \(when)")
        XCTAssertGreaterThan(answer.frame.maxY, input.frame.minY - 200, "the end is just above the composer \(when)")
        XCTAssertFalse(jump.exists, "and Scroll to end stays away \(when)")
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
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
