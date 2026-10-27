import XCTest

/// Administering a machine from the phone, as the web's Fleet settings: pair another device and
/// cancel its link, see linked machines, and set fleet-wide rules. Run a fresh fixture first
/// (`ACE_IOS_SPIKE_PORT=9884 bun run spike:daemon`); `TEST_RUNNER_ACE_IOS_SPIKE_PORT` picks its
/// port and `TEST_RUNNER_ACE_IOS_SHOTS` a folder that keeps each screenshot.
@MainActor final class MachineAdminUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testPairingAViewOnlyDeviceListsItsLinkUntilCancelled() {
        let app = launch()
        openMachine(app)
        app.buttons["machine.devices"].tap()
        let pair = app.buttons["devices.pair"]
        XCTAssertTrue(pair.waitForExistence(timeout: 20), "the machine's devices load")
        shot("machine-devices", app)
        pair.tap()
        XCTAssertTrue(app.buttons["pair.access.read"].waitForExistence(timeout: 10))
        app.textFields["pair.label"].tap()
        app.textFields["pair.label"].typeText("Kitchen iPad")
        app.buttons["pair.access.read"].tap()
        shot("pair-device-form", app)
        app.buttons["pair.make"].tap()
        XCTAssertTrue(app.staticTexts["pair.code"].waitForExistence(timeout: 20), "the machine made a link")
        shot("pair-device-link", app)
        app.buttons["Done"].tap()
        let cancel = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "devices.cancel.")).firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 20), "the open link is listed")
        XCTAssertTrue(app.staticTexts["Kitchen iPad"].exists)
        shot("machine-devices-open-link", app)
        cancel.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: cancel)
        wait(for: [gone], timeout: 20)
    }

    func testLinkedMachinesAndFleetRulesShowEveryMachinesValues() {
        let app = launch()
        openMachine(app)
        app.buttons["machine.links"].tap()
        XCTAssertTrue(app.navigationBars["Linked machines"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "reaches")).firstMatch.waitForExistence(timeout: 20))
        shot("machine-links", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let rules = app.buttons["machines.fleetRules"]
        XCTAssertTrue(rules.waitForExistence(timeout: 10))
        rules.tap()
        XCTAssertTrue(app.switches["Remote access"].waitForExistence(timeout: 20), "the rules read every machine's values")
        shot("fleet-rules", app)
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9884"]
        app.launch()
        return app
    }
    private func openMachine(_ app: XCUIApplication) {
        app.openBrowseDestination("inbox.machines")
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "machines.row.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        shot("machines", app)
        row.tap()
        XCTAssertTrue(app.buttons["machine.devices"].waitForExistence(timeout: 20))
        shot("machine-detail", app)
    }
    private func shot(_ name: String, _ app: XCUIApplication) {
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
