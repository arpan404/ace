import XCTest

/// Opt-in: pairs this simulator with a real daemon through the app's own pairing screen, so launch
/// and inbox timing can be measured on real saved data. `TEST_RUNNER_ACE_PAIR_LINK` carries the
/// link from `ace pair`; nothing here sends a message or starts an agent.
@MainActor final class RealDaemonPairUITests: XCTestCase {
    func testPairsWithTheLinkAndShowsTheInbox() throws {
        let link = try XCTUnwrap(ProcessInfo.processInfo.environment["ACE_PAIR_LINK"].flatMap { $0.isEmpty ? nil : $0 },
                                 "Set TEST_RUNNER_ACE_PAIR_LINK to a link from `ace pair`")
        let app = XCUIApplication()
        app.launch()
        // With nothing paired the inbox opens on Add device.
        let add = app.buttons["inbox.empty.pair"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        add.tap()
        let field = app.textFields["pairing.link"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText(link)
        app.buttons["pairing.continue"].tap()
        let name = app.textFields["pairing.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 20))
        app.buttons["pairing.confirm"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
            .waitForExistence(timeout: 60))
    }
}
