import XCTest

/// Spade on the spike fixture (`scripts/spade-scenario.ts`): its tab after Chats while the
/// machine shows it, the bots in web's order, a conversation streaming a reply, an approval
/// answered and a message sent, a card of questions answered (and locked while Spade's update is
/// on its way, and kept as filled in through Answer later), and the tab gone once Settings ›
/// Beta turns Spade off; a group's conversation with each member's face and name; a bot's
/// profile sheet.
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
        let tab = app.homeTab("spade")
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
        XCTAssertFalse(app.homeTab("spade").isHittable)
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

    func testACardOfQuestionsIsAnsweredAndOneForLaterOpensFromTheTopBar() {
        let app = launch()
        _ = openSpade(app)
        let planner = app.buttons["spade.bot.planner"]
        XCTAssertTrue(planner.waitForExistence(timeout: 20))
        planner.tap()
        let card = app.descendants(matching: .any)["spade.question"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Where to?"].exists)
        app.buttons["spade.question.option.1"].tap()
        XCTAssertTrue(app.buttons["spade.question.option.1"].isSelected)
        screenshot("spade-7-question")

        app.buttons["spade.question.next"].tap()
        let nights = app.textFields["spade.question.number"]
        XCTAssertTrue(nights.waitForExistence(timeout: 5))
        nights.tap()
        nights.typeText("30")
        // A number pad has no return key: Done puts it away, so Send shows.
        app.buttons["spade.question.numberDone"].tap()
        app.buttons["spade.question.send"].tap()
        // The bridge checks the card before Spade sees it, and says why under the question.
        XCTAssertTrue(app.staticTexts["At most 14."].waitForExistence(timeout: 10))
        screenshot("spade-8-question-refused")
        nights.tap()
        nights.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2) + "3")
        app.buttons["spade.question.numberDone"].tap()
        app.buttons["spade.question.send"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["You: 3 nights"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["You: Porto"].exists)
        screenshot("spade-9-question-answered")

        // The card left for later opens from the top bar's count, and folds back.
        let later = app.buttons["spade.forLater"]
        XCTAssertTrue(later.waitForExistence(timeout: 10))
        XCTAssertEqual(later.label, "1 question for later")
        later.tap()
        XCTAssertTrue(app.staticTexts["Any places you'd rather skip?"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["spade.question.text"].exists || app.textViews["spade.question.text"].exists)
        screenshot("spade-10-question-for-later")
        app.buttons["spade.question.later"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["spade.question.folded"].waitForExistence(timeout: 5))
    }

    func testASentCardStaysLockedThroughReopeningUntilSpadesUpdateSettlesIt() async throws {
        // Spade takes the answer at once but sends its update only on `release`.
        try await stage("hold")
        let app = launch()
        _ = openSpade(app)
        let planner = app.buttons["spade.bot.planner"]
        XCTAssertTrue(planner.waitForExistence(timeout: 20))
        planner.tap()
        let porto = app.buttons["spade.question.option.1"]
        XCTAssertTrue(porto.waitForExistence(timeout: 15))
        porto.tap()
        app.buttons["spade.question.next"].tap()
        let nights = app.textFields["spade.question.number"]
        XCTAssertTrue(nights.waitForExistence(timeout: 5))
        nights.tap()
        nights.typeText("5")
        app.buttons["spade.question.numberDone"].tap()
        let send = app.buttons["spade.question.send"]
        send.tap()

        // Taken but not yet settled: Send stays off, so a second tap can't post it again.
        await fulfillment(of: [expectation(for: NSPredicate(format: "enabled == false"), evaluatedWith: send)], timeout: 5)
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(send.exists)
        XCTAssertFalse(send.isEnabled)
        screenshot("spade-11-question-sending")

        // Left and reopened before the update: the card is drawn again, and stays locked.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(planner.waitForExistence(timeout: 10))
        planner.tap()
        let next = app.buttons["spade.question.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 15))
        XCTAssertFalse(next.isEnabled)
        XCTAssertFalse(app.buttons["spade.question.dismiss"].isEnabled)

        try await stage("release")
        XCTAssertTrue(app.descendants(matching: .any)["You: 5 nights"].waitForExistence(timeout: 15))
    }

    func testAnswerLaterKeepsWhatWasFilledInWhenTheCardIsOpenedAgain() {
        let app = launch()
        _ = openSpade(app)
        let planner = app.buttons["spade.bot.planner"]
        XCTAssertTrue(planner.waitForExistence(timeout: 20))
        planner.tap()
        let porto = app.buttons["spade.question.option.1"]
        XCTAssertTrue(porto.waitForExistence(timeout: 15))
        porto.tap()
        XCTAssertTrue(porto.isSelected)

        // Left for later, the card folds to its line; opened again, Porto is still picked.
        app.buttons["spade.question.later"].tap()
        let answer = app.buttons.matching(identifier: "spade.question.answer")
        let folded = NSPredicate(format: "count >= 2")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: folded, evaluatedWith: answer)], timeout: 10), .completed)
        XCTAssertFalse(app.buttons["spade.question.option.1"].exists)
        answer.element(boundBy: answer.count - 1).tap()
        XCTAssertTrue(app.buttons["spade.question.option.1"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["spade.question.option.1"].isSelected)
        screenshot("spade-12-question-kept")

        // Never mind settles it, so the next test starts with one card for later again.
        app.buttons["spade.question.dismiss"].tap()
        XCTAssertTrue(app.buttons["spade.question.option.1"].waitForNonExistence(timeout: 10))
    }

    func testAGroupListsWithItsMembersAndShowsEachMembersFaceAndName() {
        let app = launch()
        _ = openSpade(app)
        let group = app.buttons["spade.group.launch"]
        XCTAssertTrue(group.waitForExistence(timeout: 20))
        XCTAssertTrue(group.label.contains("Launch team"))
        XCTAssertTrue(group.label.contains("Spade: Want me to post it Friday morning?"))
        screenshot("spade-13-list-group")

        group.tap()
        XCTAssertTrue(element(app, labelled: "Plan the launch post for Friday").waitForExistence(timeout: 15))
        // Each member speaks under its own name; a handoff is one line, never a tool call.
        XCTAssertTrue(element(app, labelled: "Research: Installs are up").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, labelled: "Spade: I'll ask Research").exists)
        XCTAssertTrue(app.staticTexts["Spade asked Research"].exists)
        // A group's title shows its members and opens no bot's profile.
        XCTAssertFalse(app.buttons["spade.profile"].exists)
        screenshot("spade-14-group")
    }

    func testABotsProfileOpensFromItsNameWithDetailsLibraryAndComputer() {
        let app = launch()
        _ = openSpade(app)
        let notes = app.buttons["spade.bot.notes"]
        XCTAssertTrue(notes.waitForExistence(timeout: 20))
        notes.tap()
        let profile = app.buttons["spade.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 15))
        profile.tap()

        XCTAssertTrue(element(app, labelled: "Summarise what merged each day").waitForExistence(timeout: 15))
        XCTAssertTrue(element(app, labelled: "Morning summary").exists)
        XCTAssertTrue(element(app, labelled: "Sonnet").exists)
        screenshot("spade-15-profile-details")

        app.buttons["Library"].tap()
        XCTAssertTrue(element(app, labelled: "Keep summaries to three lines.").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, labelled: "Daily digest").exists)
        screenshot("spade-16-profile-library")

        app.buttons["Computer"].tap()
        XCTAssertTrue(element(app, labelled: "Asleep until it's needed").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, labelled: "Digest preview").exists)
        screenshot("spade-17-profile-computer")

        app.buttons["spade.profile.done"].tap()
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        XCTAssertTrue(profile.isHittable)
    }

    /// The first element whose label holds `text`, wherever SwiftUI put it.
    private func element(_ app: XCUIApplication, labelled text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func testTheTabGoesWhenBetaTurnsSpadeOff() async throws {
        let app = launch()
        let tab = openSpade(app)
        XCTAssertTrue(app.buttons["spade.bot.spade"].waitForExistence(timeout: 20))
        screenshot("spade-5-tab-on")

        try await stage("off")

        XCTAssertTrue(tab.waitForNonExistence(timeout: 15))
        // Back on Projects, the place it left for.
        XCTAssertTrue(app.homeTab("threads").isSelected)
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
