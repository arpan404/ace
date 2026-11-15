import XCTest

/// The phone's media connection end to end on the spike fixture, started with
/// `ACE_IOS_SPIKE_MEDIA=1 ACE_IOS_SPIKE_POSTER=hold ACE_IOS_SPIKE_DEGRADED=1`: the fixture plays
/// ace-media's media listener on loopback (`scripts/spike-media.ts`). The live browser shows the
/// subscribe's poster, then its video by the media connection with acks there; a dropped
/// connection is reopened and the view subscribes again on the new one; a daemon gone to legacy
/// delivery keeps the page live on the main socket; and the degraded sentence stays throughout.
final class MediaConnectionUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    private struct Media: Decodable {
        let welcomed: [String]
        let named: [String]
        let acks: [String: Int]
        let unavailable: Int
        let mainAcks: Int
        var browserAcks: Int { acks["browser.ack"] ?? 0 }
    }

    @MainActor func testTheLiveBrowserRunsOnTheMediaConnectionAndKeepsGoing() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        let row = app.buttons["thread.ios-browser"]
        app.bringToMiddle(row)
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 30))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        let surface = app.descendants(matching: .any)["browser.surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 20))
        let sentence = app.staticTexts["Video runs on the processor here: this computer has no hardware video encoder."]
        XCTAssertTrue(sentence.waitForExistence(timeout: 20))

        // The poster, while the fixture holds the video back; the subscribe named the connection.
        wait("the poster", 30) { (surface.value as? String) == "Still picture" }
        wait("a subscribe on the welcomed connection", 30) { self.media().map { !$0.named.isEmpty && $0.welcomed.contains($0.named.last!) } ?? false }
        screenshot("media-1-poster")

        // Video by the media connection, acknowledged there.
        post("/poster", [:])
        wait("acks on the media connection", 30) { (self.media()?.browserAcks ?? 0) >= 1 }
        wait("the first live picture", 20) { (surface.value as? String) != "Still picture" }
        let first = try XCTUnwrap(media())
        screenshot("media-2-live")

        // ace-media goes away: a new connection, and the view subscribed again on it.
        post("/media", ["action": "drop"])
        wait("a new connection that the view names", 40) {
            guard let now = self.media(), now.welcomed.count > first.welcomed.count, let last = now.welcomed.last else { return false }
            return now.named.last == last && now.browserAcks > first.browserAcks
        }
        XCTAssertTrue(sentence.exists)
        screenshot("media-3-reconnected")

        // Legacy delivery: the page stays live on the main socket.
        let before = try XCTUnwrap(media())
        post("/media", ["action": "legacy"])
        wait("pictures acknowledged on the main socket", 40) {
            guard let now = self.media() else { return false }
            return now.unavailable > 0 && now.mainAcks > before.mainAcks
        }
        XCTAssertTrue(sentence.exists)
        screenshot("media-4-legacy")
    }

    private func media() -> Media? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/media"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Media.self, from: data)
    }
    private func post(_ path: String, _ body: [String: String]) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = "POST"
        request.httpBody = try? JSONEncoder().encode(body)
        let done = expectation(description: "POST \(path)")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        XCTAssertEqual(XCTWaiter().wait(for: [done], timeout: 10), .completed)
    }
    private func wait(_ what: String, _ seconds: TimeInterval, until condition: @escaping () -> Bool) {
        let met = expectation(for: NSPredicate { _, _ in condition() }, evaluatedWith: NSNull())
        guard XCTWaiter().wait(for: [met], timeout: seconds) == .completed else {
            screenshot("media-failed")
            XCTFail("Timed out waiting for \(what): \(String(describing: media()))")
            return
        }
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
