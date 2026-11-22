import XCTest

/// Organization spaces on two fixture machines (`scripts/space-scenario.ts`): run with
/// `ACE_IOS_SPIKE_SPACE=personal ACE_IOS_SPIKE_ORG_HOSTS=ios-spike-host-9863` on 9852 and
/// `ACE_IOS_SPIKE_SPACE=acme` on 9863. In Acme Robotics' space Spade lists the host's bots,
/// Builder marked Shared, and Builder's request says who may answer it.
@MainActor final class SpacesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testASharedBotIsMarkedAndItsRequestSaysWhoCanAnswer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", "9852", "--spike-machines", "9852,9863", "--spike-account"]
        app.launchWithArguments()
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
