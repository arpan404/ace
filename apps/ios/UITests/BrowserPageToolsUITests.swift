import XCTest

/// The browser's page commands and annotate mode on the spike fixture's checkout page: Ask agent
/// about this page puts the page in the message, annotate pins comments that join the message,
/// the menu's sheets (page source, screenshots at sizes, extensions) open with what the page
/// has, a download is saved onto the phone, and the page is recorded and stopped.
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
    private func control(_ action: String) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/browser")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await URLSession.shared.data(for: request)
    }
    private func item(_ app: XCUIApplication, _ identifier: String, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", identifier, label)).firstMatch
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

        // Annotate: the strip says so, two pins join the message as chips.
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        let annotate = item(app, "browser.annotate", "Annotate")
        XCTAssertTrue(annotate.waitForExistence(timeout: 10))
        annotate.tap()
        XCTAssertTrue(app.buttons["browser.annotate.done"].waitForExistence(timeout: 10))
        try await control("pin")
        try await control("region")
        let sentence = app.staticTexts["2 annotations on the message"]
        XCTAssertTrue(sentence.waitForExistence(timeout: 10))
        screenshot("browser-tools-3-annotating")
        app.buttons["browser.annotate.message"].tap()
        XCTAssertTrue(app.buttons["composer.annotation.2"].waitForExistence(timeout: 10))
        sleep(1)
        screenshot("browser-tools-4-chips")
        app.buttons["composer.annotation.1"].tap()
        let remove = app.buttons["Remove"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        XCTAssertTrue(app.buttons["composer.annotation.2"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["composer.annotation.1"].exists)
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
