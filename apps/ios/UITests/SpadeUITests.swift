import XCTest

/// Spade on the spike fixture (`scripts/spade-scenario.ts`): its tab after Chats while the
/// machine shows it, the bots in web's order, a conversation streaming a reply, an approval
/// answered and a message sent, and the tab gone once Settings › Beta turns Spade off.
@MainActor final class SpadeUITests: XCTestCase {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() async throws {
        continueAfterFailure = false
        // Every test starts with Spade shown, whatever the last one left. (In setUp, not
        // tearDown: an async tearDown after a failed assertion hung the whole run.)
        try await stage("on")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launchWithArguments()
        return app
    }

    /// Stages Spade on the fixture: `off`, `on` or `stream`.
    private func stage(_ kind: String) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/review/spade")))
        request.httpMethod = "POST"
        request.httpBody = Data("\"\(kind)\"".utf8)
        _ = try await URLSession.shared.data(for: request)
    }

    private func openSpade(_ app: XCUIApplication) -> XCUIElement {
        let tab = app.tabBars.buttons["Spade"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        return tab
    }

    func testTheSpadeTabListsTheBotsInWebsOrderAndOpensOne() throws {
        let app = launch()
        _ = openSpade(app)
        let spade = app.buttons["spade.bot.spade"], builder = app.buttons["spade.bot.builder"]
        let research = app.buttons["spade.bot.research"], notes = app.buttons["spade.bot.notes"]
        XCTAssertTrue(notes.waitForExistence(timeout: 20))
        // Spade first, then the bot waiting on the person, then the working one, then the rest.
        let ys = [spade, builder, research, notes].map(\.frame.minY)
        XCTAssertEqual(ys, ys.sorted())
        XCTAssertTrue(builder.label.contains("Waiting for you") || builder.label.contains("Needs you"))
        screenshot("spade-1-list")

        notes.tap()
        XCTAssertTrue(app.staticTexts["Summarise yesterday's PRs"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.tabBars.buttons["Spade"].isHittable)
        screenshot("spade-2-conversation")
    }

    func testAReplyStreamsInAndAMessageSends() async throws {
        let app = launch()
        _ = openSpade(app)
        let notes = app.buttons["spade.bot.notes"]
        XCTAssertTrue(notes.waitForExistence(timeout: 20))
        notes.tap()
        XCTAssertTrue(app.staticTexts["Summarise yesterday's PRs"].waitForExistence(timeout: 15))

        try await stage("stream")
        XCTAssertTrue(app.descendants(matching: .any)["spade.working"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["spade.stop"].waitForExistence(timeout: 10))
        screenshot("spade-3-streaming")

        let composer = app.textFields["spade.composer"].exists ? app.textFields["spade.composer"] : app.textViews["spade.composer"]
        composer.tap()
        composer.typeText("Keep it short")
        app.buttons["spade.send"].tap()
        XCTAssertTrue(app.staticTexts["Keep it short"].waitForExistence(timeout: 15))
    }

    func testAnApprovalIsAnsweredFromTheConversation() {
        let app = launch()
        _ = openSpade(app)
        let builder = app.buttons["spade.bot.builder"]
        XCTAssertTrue(builder.waitForExistence(timeout: 20))
        builder.tap()
        let allow = app.buttons["spade.allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Builder wants to run a command."].exists)
        XCTAssertTrue(app.buttons["spade.alwaysAllow"].exists)
        screenshot("spade-4-approval")
        allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout: 15))
    }

    func testTheTabGoesWhenBetaTurnsSpadeOff() async throws {
        let app = launch()
        let tab = openSpade(app)
        XCTAssertTrue(app.buttons["spade.bot.spade"].waitForExistence(timeout: 20))
        screenshot("spade-5-tab-on")

        try await stage("off")

        XCTAssertTrue(tab.waitForNonExistence(timeout: 15))
        // Back on Projects, the place it left for.
        XCTAssertTrue(app.tabBars.buttons["Projects"].isSelected)
        screenshot("spade-6-tab-off")
        try await stage("on")
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
