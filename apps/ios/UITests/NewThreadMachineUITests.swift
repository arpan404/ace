import XCTest

/// New thread with two fixture machines: each machine keeps its own project, and the sheet opens
/// on the machine chosen last. Run two separate-host fixtures first, as `MachinesUITests` does;
/// `TEST_RUNNER_ACE_IOS_SPIKE_MACHINES` picks other ports and `TEST_RUNNER_ACE_IOS_SHOTS` a
/// folder for the screenshots.
@MainActor final class NewThreadMachineUITests: XCTestCase, @unchecked Sendable {
    private var ports: [String] { (ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_MACHINES"] ?? "9852,9863").split(separator: ",").map(String.init) }
    override func setUp() { continueAfterFailure = false }

    func testSwitchingMachineBringsBackItsProjectAndTheSheetReopensOnTheLastMachine() {
        var app = launch()
        open(app)
        let machine = app.descendants(matching: .any)["newThread.machine"].firstMatch
        XCTAssertTrue(machine.waitForExistence(timeout: 20))
        let first = "studio-\(ports[0])", second = "studio-\(ports[1])"
        if machine.value as? String != first { choose(app, first) }
        pickProject(app)
        screenshot("first-machine")

        choose(app, second)
        XCTAssertEqual(app.buttons["newThread.project"].label, "Choose a project", "a machine never used has no project yet")
        pickProject(app)
        screenshot("second-machine")

        choose(app, first)
        screenshot("back-on-first-machine")
        XCTAssertEqual(app.buttons["newThread.project"].label, "Project, ace-next", "the machine's last project comes back")

        choose(app, second)
        app.terminate()
        app = launch()
        open(app)
        XCTAssertTrue(machine.waitForExistence(timeout: 20))
        screenshot("relaunched")
        XCTAssertEqual(app.descendants(matching: .any)["newThread.machine"].firstMatch.value as? String, second, "the machine chosen last opens")
        app.terminate()
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-machines", ports.joined(separator: ",")]
        app.launch()
        return app
    }
    private func open(_ app: XCUIApplication) {
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 30))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
    }
    private func choose(_ app: XCUIApplication, _ name: String) {
        app.descendants(matching: .any)["newThread.machine"].firstMatch.tap()
        let option = app.buttons[name].firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        let chosen = NSPredicate(format: "value == %@", name)
        wait(for: [expectation(for: chosen, evaluatedWith: app.descendants(matching: .any)["newThread.machine"].firstMatch)], timeout: 10)
    }
    private func pickProject(_ app: XCUIApplication) {
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        app.buttons["project.ace"].tap()
        let named = NSPredicate(format: "label == %@", "Project, ace-next")
        wait(for: [expectation(for: named, evaluatedWith: app.buttons["newThread.project"])], timeout: 10)
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-newthread-machine-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("newthread-machine-\(name).png"))
        }
    }
}
