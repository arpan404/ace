import XCTest

/// The browser's page commands and annotate mode on the spike fixture's checkout page: Ask agent
/// about this page puts the page in the message, annotate pins comments that join the message,
/// the menu's sheets (page source, screenshots at sizes, extensions) open with what the page
/// has, a download is saved onto the phone, the page is recorded and stopped, watch mode follows
/// the agent and the thread's browser moves to another engine.
final class BrowserPageToolsUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    @MainActor private func openBrowser(_ app: XCUIApplication) {
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        let row = app.buttons["thread.ios-browser"]
        app.bringToMiddle(row)
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 15))
        sleep(2)
    }
    /// The fixture browser as the spike daemon holds it: its engine and pages.
    private struct FixtureBrowser: Decodable { let backend: String?; let closed: Bool; let url: String?; let tabs: [String] }
    private func fixtureBrowser() async throws -> FixtureBrowser {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/browser"))
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(FixtureBrowser.self, from: data)
    }
    private func control(_ action: String) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/browser")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await URLSession.shared.data(for: request)
    }
    /// A menu row by its identifier or label. A menu taller than the screen lists only the rows
    /// on screen, so it is scrolled toward its top (where the tab's rows are) until the row shows.
    private func item(_ app: XCUIApplication, _ identifier: String, _ label: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", identifier, label)).firstMatch
        for _ in 0..<4 where !row.waitForExistence(timeout: 1) {
            let menu = app.collectionViews.firstMatch
            guard menu.exists else { break }
            menu.swipeDown()
        }
        return row
    }

    @MainActor func testAskingAboutThePageAndAnnotatingItFillTheMessage() async throws {
        let app = XCUIApplication()
        openBrowser(app)
        screenshot("browser-tools-1-bar")
        // Ask agent about this page: back to the thread, the page's title in the message.
        let ask = item(app, "browser.ask", "Ask agent about this page")
        XCTAssertTrue(ask.waitForExistence(timeout: 10))
        ask.tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let asked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Checkout"), object: input)
        XCTAssertEqual(XCTWaiter.wait(for: [asked], timeout: 10), .completed, "the page's title never reached the message")
        screenshot("browser-tools-2-asked")

        // Draw: the pen over the page turns drawing on; two drawings join the message as one chip.
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        let pen = app.buttons["browser.annotate"]
        XCTAssertTrue(pen.waitForExistence(timeout: 10))
        pen.tap()
        XCTAssertTrue(app.buttons["browser.annotate.done"].waitForExistence(timeout: 10))
        try await control("pin")
        try await control("region")
        XCTAssertTrue(app.staticTexts["Draw another"].waitForExistence(timeout: 10))
        screenshot("browser-tools-3-annotating")
        app.buttons["browser.annotate.message"].tap()
        let chip = app.buttons["composer.annotations"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertEqual(chip.label, "2 drawings attached")
        sleep(1)
        screenshot("browser-tools-4-chips")
        chip.tap()
        let remove = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove 2'")).firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        let one = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Drawing 1 attached'"), object: chip)
        XCTAssertEqual(XCTWaiter.wait(for: [one], timeout: 10), .completed)
    }

    @MainActor func testTheMenusSheetsShowWhatThePageHas() {
        let app = XCUIApplication()
        openBrowser(app)
        app.buttons["browser.menu"].tap()
        sleep(1)
        screenshot("browser-tools-5-menu")
        item(app, "browser.menu.source", "Page source").tap()
        XCTAssertTrue(app.textViews["browser.source.text"].waitForExistence(timeout: 10))
        screenshot("browser-tools-6-source")
        app.buttons["Close"].firstMatch.tap()

        app.buttons["browser.menu"].tap()
        item(app, "browser.menu.extensions", "Extensions").tap()
        XCTAssertTrue(app.staticTexts["React Developer Tools"].waitForExistence(timeout: 10))
        screenshot("browser-tools-7-extensions")
        app.buttons["Close"].firstMatch.tap()

        app.buttons["browser.menu"].tap()
        app.buttons["Take screenshot"].tap()
        item(app, "browser.menu.sizes", "At several sizes…").tap()
        XCTAssertTrue(app.buttons["browser.sizes.take"].waitForExistence(timeout: 10))
        screenshot("browser-tools-8-sizes")
        app.buttons["browser.sizes.take"].tap()
        // The first size's shot (the rest follow below it in the list).
        XCTAssertTrue(app.descendants(matching: .any)["browser.sizes.shot.phone"].waitForExistence(timeout: 20))
        sleep(1)
        screenshot("browser-tools-9-sizes-taken")
        app.buttons["Close"].firstMatch.tap()

        // A download saved onto the phone, then offered to share.
        app.buttons["browser.menu"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Downloads'")).firstMatch.tap()
        let save = app.buttons["browser.download.save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        save.tap()
        XCTAssertTrue(app.buttons["browser.download.share"].waitForExistence(timeout: 15))
        screenshot("browser-tools-10-saved")
        app.buttons["Close"].firstMatch.tap()

        // Record the page, then stop from the strip.
        app.buttons["browser.menu"].tap()
        item(app, "browser.menu.record", "Record the page").tap()
        let stop = app.buttons["browser.record.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        screenshot("browser-tools-11-recording")
        stop.tap()
        XCTAssertTrue(app.buttons["browser.done"].waitForExistence(timeout: 10))
        screenshot("browser-tools-12-recording-saved")
        XCTAssertTrue(stop.waitForNonExistence(timeout: 10))

        // Clearing browsing data asks first, in red.
        app.buttons["browser.menu"].tap()
        item(app, "browser.menu.clear", "Clear browsing data…").tap()
        let confirm = app.buttons["Clear browsing data"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("browser-tools-13-clear")
        confirm.tap()
        XCTAssertTrue(app.buttons["browser.done"].waitForExistence(timeout: 10))
    }

    /// Watch mode follows the agent and shows a strip while on; Engine for this thread moves the
    /// thread's browser to ace's Chrome and the page comes back there.
    @MainActor func testWatchingTheAgentAndMovingTheBrowserToAnotherEngine() async throws {
        let app = XCUIApplication()
        openBrowser(app)
        app.buttons["browser.menu"].tap()
        item(app, "browser.menu.watch", "Watch the agent").tap()
        let stop = app.buttons["browser.watch.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        screenshot("browser-watch-1-on")
        stop.tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 10))

        let before = try await fixtureBrowser()
        XCTAssertNotEqual(before.backend, "headless")
        app.buttons["browser.menu"].tap()
        item(app, "browser.menu.engine", "Engine for this thread").tap()
        let chrome = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@",
                                                      "browser.menu.engine.headless", "ace's Chrome only")).firstMatch
        XCTAssertTrue(chrome.waitForExistence(timeout: 5))
        screenshot("browser-engine-1-menu")
        chrome.tap()
        // The thread's browser now runs in ace's Chrome, with the same pages and the same one shown.
        var after = try await fixtureBrowser()
        for _ in 0..<30 where after.backend != "headless" || after.closed || after.tabs.count < before.tabs.count {
            try await Task.sleep(for: .milliseconds(500))
            after = try await fixtureBrowser()
        }
        XCTAssertEqual(after.backend, "headless")
        XCTAssertFalse(after.closed)
        XCTAssertEqual(Set(after.tabs), Set(before.tabs))
        XCTAssertEqual(after.url, before.url)
        XCTAssertFalse(app.alerts["Browser"].exists)
        // And the phone shows that page again.
        let address = app.buttons["browser.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        let host = try XCTUnwrap(before.url.flatMap { URL(string: $0)?.host() })
        XCTAssertTrue((address.value as? String)?.contains(host) == true)
        screenshot("browser-engine-2-moved")
    }

    /// The address starts with the page's security mark, and with Connection stats on the menu
    /// shows the round trip of the person's input to the page.
    @MainActor func testTheAddressMarksTheConnectionAndTheMenuShowsTheRoundTrip() {
        let app = XCUIApplication()
        openBrowser(app)
        let address = app.buttons["browser.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        XCTAssertTrue((address.value as? String)?.contains("Secure connection") == true)
        // A touch on the page, so there is a round trip to show.
        app.descendants(matching: .any)["browser.surface"].firstMatch.tap()
        sleep(1)
        app.buttons["browser.menu"].tap()
        // A menu's switch and its plain rows read as buttons or switches depending on the OS.
        let stats = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@",
                                                                         "browser.menu.connectionStats", "Connection stats")).firstMatch
        XCTAssertTrue(stats.waitForExistence(timeout: 5))
        stats.tap()
        app.buttons["browser.menu"].tap()
        let latency = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Input round trip'")).firstMatch
        XCTAssertTrue(latency.waitForExistence(timeout: 5))
        screenshot("browser-connection-1-stats")
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
