import XCTest

/// Settings › Tools › Agents against two separate fixture machines: run
/// `ACE_IOS_SPIKE_PORT=9886 ACE_IOS_SPIKE_MACHINE=1 bun run spike:daemon` and the same on 9896
/// (`TEST_RUNNER_ACE_IOS_AGENTS_PORTS` overrides them). The page shows the web's rows, a usage-limit
/// choice says what it means, a role takes a model from the composer's picker, and All machines
/// sends a change to both machines. `ACE_IOS_SHOTS` (a folder) also saves each screenshot there.
@MainActor final class AgentsSettingsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testTheAgentsPageSetsLimitsRolesAndSendsAChangeToEveryMachine() {
        let app = XCUIApplication()
        let ports = ProcessInfo.processInfo.environment["ACE_IOS_AGENTS_PORTS"] ?? "9886,9896"
        // The app's own appearance preference wins over the simulator's; another test may leave it light.
        app.launchArguments = ["--spike", "--spike-machines", ports, "-ace.appearance", "dark"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 30))
        app.openBrowseDestination("library.agents")

        let limit = element("setting.threads.limitPolicy", in: app)
        XCTAssertTrue(limit.waitForExistence(timeout: 20))
        XCTAssertTrue(element("setting.providers.default", in: app).exists)
        screenshot("agents-top")

        // A usage-limit choice is saved and the line under it says what it does.
        reveal(limit, in: app)
        limit.tap()
        app.buttons["Resume when it resets"].firstMatch.tap()
        let note = element("setting.threads.limitPolicy.note", in: app)
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(note, label: "At the limit it waits and resumes when the window resets."))
        screenshot("agents-limit")

        // A role opens its own page; its model comes from the composer's picker.
        let build = element("setting.roles.build", in: app)
        reveal(build, in: app)
        screenshot("agents-roles")
        build.tap()
        let roleModel = element("setting.role.model", in: app)
        XCTAssertTrue(roleModel.waitForExistence(timeout: 15))
        screenshot("role-unset")
        roleModel.tap()
        let firstModel = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "settingsModel.")).firstMatch
        let listed = firstModel.waitForExistence(timeout: 20)
        screenshot("role-model-sheet")
        XCTAssertTrue(listed, "the sheet lists the machine's models")
        firstModel.tap()
        app.buttons["modelSheet.done"].tap()
        XCTAssertTrue(element("setting.role.effort", in: app).waitForExistence(timeout: 20), "a set role offers its efforts")
        let clear = element("setting.role.model.clear", in: app)
        XCTAssertTrue(clear.waitForExistence(timeout: 10), "a set role offers Clear")
        screenshot("role-set")
        clear.tap()
        XCTAssertTrue(element("setting.role.effort", in: app).waitForNonExistence(timeout: 15), "Clear with no effort set asks nothing")
        screenshot("role-cleared")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // All machines: the change goes to both, and the footer names them.
        let scope = app.segmentedControls["settings.scope"].firstMatch
        reveal(scope, in: app, up: true)
        XCTAssertTrue(scope.waitForExistence(timeout: 10))
        scope.buttons["All machines"].tap()
        let targets = element("settings.scope.targets", in: app)
        XCTAssertTrue(targets.waitForExistence(timeout: 10))
        screenshot("agents-all-machines")
        let children = element("setting.agents.maxRunningChildren", in: app)
        reveal(children, in: app)
        children.tap()
        app.buttons["4"].firstMatch.tap()
        XCTAssertTrue(element("setting.agents.maxRunningChildren.note", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor(element("setting.agents.maxRunningChildren.note", in: app),
                              label: "More agents a thread hands work to wait and start as these finish."))
        XCTAssertFalse(app.descendants(matching: .any)["service.problem"].exists, "both machines took the change")
        screenshot("agents-children-all")
    }

    private func element(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, up: Bool = false) {
        for _ in 0..<8 where !(element.exists && element.isHittable) { if up { app.swipeDown() } else { app.swipeUp() } }
    }
    private func waitFor(_ element: XCUIElement, label: String) -> Bool {
        let predicate = NSPredicate(format: "label == %@", label)
        return XCTWaiter().wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: 10) == .completed
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "agents-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
