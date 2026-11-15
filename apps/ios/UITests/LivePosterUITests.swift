import XCTest

/// The subscribe's poster (ADR 0149), on the spike fixture started with
/// `ACE_IOS_SPIKE_POSTER=hold`: the live browser shows the poster at once while the page's video
/// is held back, and the first live picture replaces it once the fixture lets video through.
final class LivePosterUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    @MainActor func testThePosterShowsUntilTheFirstLivePicture() throws {
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
        let still = NSPredicate { element, _ in ((element as? XCUIElement)?.value as? String) == "Still picture" }
        guard XCTWaiter().wait(for: [expectation(for: still, evaluatedWith: surface)], timeout: 20) == .completed else {
            screenshot("poster-0-missing")
            return XCTFail("the poster never showed")
        }
        screenshot("poster-1-still")

        try release()
        let live = NSPredicate { element, _ in ((element as? XCUIElement)?.value as? String ?? "") != "Still picture" }
        guard XCTWaiter().wait(for: [expectation(for: live, evaluatedWith: surface)], timeout: 30) == .completed else {
            return XCTFail("the first live picture never replaced the poster")
        }
        sleep(2)
        screenshot("poster-2-live")
    }

    /// Lets the fixture's held video through (`POST /poster`).
    private func release() throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/poster")))
        request.httpMethod = "POST"
        let done = expectation(description: "video released")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        XCTAssertEqual(XCTWaiter().wait(for: [done], timeout: 10), .completed)
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
