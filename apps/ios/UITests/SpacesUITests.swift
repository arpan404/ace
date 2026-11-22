import XCTest

/// Organization spaces on two fixture machines (`scripts/space-scenario.ts`): run with
/// `ACE_IOS_SPIKE_SPACE=personal ACE_IOS_SPIKE_ORG_HOSTS=ios-spike-host-9863` on 9852 and
/// `ACE_IOS_SPIKE_SPACE=acme` on 9863. In Acme Robotics' space Spade lists the host's bots,
/// Builder marked Shared, and Builder's request says who may answer it.
@MainActor final class SpacesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// Personal's threads (on 9852) and Acme Robotics' (on its host, 9863), as `space-scenario.ts` seeds them.
    private let personal = ["Back up the photo library", "Draft the blog post on Swift 6", "Rewrite the relay outbox streams",
                            "Fix the flaky queue test", "Ship the relay fix", "Deploy the preview"]
    private let acme = ["Review the safety interlock PR", "Fix conveyor sensor drift", "Calibrate the arm controller firmware"]

    /// The app on both fixture machines, signed in to the fixture account, showing `space`.
    private func launch(space: String) -> XCUIApplication {
        let app = XCUIApplication()
        // The saved choice, as `SpacesModel` keys it, through the arguments' defaults domain.
        app.launchArguments = ["--spike", "--spike-port", "9852", "--spike-machines", "9852,9863", "--spike-account",
                               "-ace.space:http://127.0.0.1:9852:acct_spike", space]
        app.launchWithArguments()
        return app
    }

    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    func testAcmesListShowsOnlyItsHostsThreadsAndNoPersonalOne() {
        let app = launch(space: "org_acme")
        for title in acme { XCTAssertTrue(row(app, title).waitForExistence(timeout: 30), title) }
        for title in personal { XCTAssertFalse(row(app, title).exists, "\(title) is a Personal thread") }
        attach(app, "2-acme-threads")
    }

    func testPersonalsListShowsNoAcmeThread() {
        let app = launch(space: "personal")
        for title in personal.prefix(2) { XCTAssertTrue(row(app, title).waitForExistence(timeout: 30), title) }
        for title in acme { XCTAssertFalse(row(app, title).exists, "\(title) is an Acme thread") }
        attach(app, "1-personal-threads")
    }

    func testASharedBotIsMarkedAndItsRequestSaysWhoCanAnswer() throws {
        let app = launch(space: "org_acme")
        let tab = app.homeTab("spade")
        XCTAssertTrue(tab.waitForExistence(timeout: 30))
        tab.tap()
        let builder = app.buttons["spade.bot.builder"]
        XCTAssertTrue(builder.waitForExistence(timeout: 20))
        // The row reads as one element: "Builder, Shared in Acme Robotics, …".
        let shared = NSPredicate(format: "label CONTAINS %@", "Shared in Acme Robotics")
        expectation(for: shared, evaluatedWith: builder)
        waitForExpectations(timeout: 20)
        attach(app, "spaces-spade-list")
        builder.tap()
        let approvers = app.staticTexts["spade.approvers"]
        XCTAssertTrue(approvers.waitForExistence(timeout: 20))
        XCTAssertEqual(approvers.label, "You or Dana Kim can answer. The first answer counts.")
        attach(app, "spaces-spade-request")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let picture = app.screenshot()
        let shot = XCTAttachment(screenshot: picture)
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
        try? picture.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/ios-spaces-shots/\(name).png"))
    }
}
