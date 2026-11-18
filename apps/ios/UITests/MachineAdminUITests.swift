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
        makeLink(app, label: "Kitchen iPad", shots: true)
        makeLink(app, label: "Hall iPad", shots: false)
        // Each link's Cancel waits in its own row's ⋯ menu, as a device's Revoke does.
        let kitchen = app.buttons["Actions for Kitchen iPad"]
        let hall = app.buttons["Actions for Hall iPad"]
        XCTAssertTrue(kitchen.waitForExistence(timeout: 20), "the first open link is listed")
        XCTAssertTrue(hall.waitForExistence(timeout: 20), "the second open link is listed")
        shot("machine-devices-open-links", app)
        kitchen.tap()
        let cancel = app.buttons["Cancel link"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        cancel.tap()
        wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: kitchen)], timeout: 20)
        XCTAssertTrue(hall.exists, "cancelling one link leaves the other open")

        // A swipe, however long, only uncovers Cancel link; the link goes once that is tapped.
        let hallRow = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Hall iPad")).firstMatch
        XCTAssertTrue(hallRow.exists)
        hallRow.swipeLeft(velocity: .fast)
        let uncovered = app.buttons["Cancel link"].firstMatch
        XCTAssertTrue(uncovered.waitForExistence(timeout: 5), "the swipe uncovers Cancel link")
        sleep(2)
        XCTAssertTrue(hall.exists, "a full swipe doesn't cancel the link by itself")
        shot("machine-devices-swiped-link", app)
        uncovered.tap()
        wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: hall)], timeout: 20)
    }

    /// Pair a device: name it, make it view-only, make the link, then close the sheet.
    private func makeLink(_ app: XCUIApplication, label: String, shots: Bool) {
        app.buttons["devices.pair"].tap()
        XCTAssertTrue(app.buttons["pair.access.read"].waitForExistence(timeout: 10))
        app.textFields["pair.label"].tap()
        app.textFields["pair.label"].typeText(label)
        app.buttons["pair.access.read"].tap()
        if shots { shot("pair-device-form", app) }
        app.buttons["pair.make"].tap()
        XCTAssertTrue(app.staticTexts["pair.code"].waitForExistence(timeout: 20), "the machine made a link")
        if shots { shot("pair-device-link", app) }
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["devices.pair"].waitForExistence(timeout: 10))
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
        app.launchWithArguments()
        return app
    }
    private func openMachine(_ app: XCUIApplication) {
        app.openBrowseDestination("inbox.machines")
        let row = app.descendants(matching: .any)["machines.row.ios-spike-host"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        shot("machines", app)
        row.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10))
        for _ in 0..<6 where !app.buttons["machine.devices"].isHittable { app.swipeUp() }
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
