import XCTest

/// A machine's page: pausing and resuming new work, Storage (preview, then a confirmed removal
/// that names what goes) and Diagnostics. Uses the spike fixture's storage
/// (`scripts/storage-scenario.ts`). `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a
/// folder) also saves each screenshot there as `care-<name>.png`.
@MainActor final class HostCareUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testPausingNewWorkShowsOnTheMachineAndOneTapResumesIt() throws {
        let app = launchIntoMachine()
        let pause = element(app, "machine.admission")
        XCTAssertTrue(pause.waitForExistence(timeout: 20))
        XCTAssertTrue(pause.label.contains("Pause new work"))
        // The desktop app's update, read-only: its version and the one line that needs the person.
        let update = element(app, "machine.appUpdate")
        XCTAssertTrue(update.waitForExistence(timeout: 10))
        XCTAssertTrue(update.label.contains("1.4.1") && update.label.contains("Restart to finish updating"))
        screenshot("machine")
        pause.tap()
        let line = element(app, "machine.admission.line")
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        XCTAssertTrue(line.label.hasPrefix("New work paused"))
        XCTAssertTrue(pause.label.contains("Resume new work"))
        screenshot("machine-paused")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let row = element(app, "machines.row.ios-spike-host")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("New work paused"))
        screenshot("machines-paused")
        row.tap()
        XCTAssertTrue(pause.waitForExistence(timeout: 10))
        pause.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: line)
        wait(for: [gone], timeout: 10)
    }

    func testStorageCleanupSaysWhatGoesBeforeRemovingIt() throws {
        let app = launchIntoMachine()
        open(app, "machine.storage")
        let preview = app.buttons["storage.preview"]
        XCTAssertTrue(preview.waitForExistence(timeout: 20))
        screenshot("storage")
        preview.tap()
        let remove = app.buttons["storage.remove"]
        for _ in 0..<6 where !remove.isHittable { app.swipeUp() }
        XCTAssertTrue(remove.waitForExistence(timeout: 20))
        screenshot("storage-preview")
        remove.tap()
        let confirm = app.buttons["storage.remove.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        screenshot("storage-confirm")
        confirm.tap()
        XCTAssertTrue(element(app, "storage.outcome").waitForExistence(timeout: 20))
        screenshot("storage-removed")
        for _ in 0..<6 { app.swipeUp() }
        screenshot("storage-settings")
    }

    func testDiagnosticsRunsReadOnlyChecksAndSharesASupportBundle() throws {
        let app = launchIntoMachine()
        open(app, "machine.diagnostics")
        let run = app.buttons["diagnostics.run"]
        XCTAssertTrue(run.waitForExistence(timeout: 20))
        screenshot("diagnostics")
        run.tap()
        XCTAssertTrue(element(app, "diagnostics.summary").waitForExistence(timeout: 30))
        screenshot("diagnostics-checks")
        let export = app.buttons["diagnostics.export"]
        for _ in 0..<4 where !export.isHittable { app.swipeUp() }
        export.tap()
        XCTAssertTrue(element(app, "diagnostics.share").waitForExistence(timeout: 30))
        screenshot("diagnostics-bundle")
        let reset = app.buttons["diagnostics.reset"]
        for _ in 0..<6 where !reset.isHittable { app.swipeUp() }
        screenshot("diagnostics-lower")
        reset.tap()
        XCTAssertTrue(app.buttons["diagnostics.reset.confirm"].firstMatch.waitForExistence(timeout: 5))
        screenshot("diagnostics-reset")
    }

    func testRenameSavesTheNameOnTheMachine() throws {
        let app = launchIntoMachine()
        // The fixture takes its host's name; read it from the page and put it back at the end.
        let original = try machineName(app)
        rename(app, to: "Studio Mac", from: original)
        XCTAssertTrue(app.navigationBars["Studio Mac"].waitForExistence(timeout: 15), "the page takes the machine's new name")
        screenshot("machine-renamed")
        rename(app, to: original, from: "Studio Mac")
        XCTAssertTrue(app.navigationBars[original].waitForExistence(timeout: 15))
    }

    func testStartingTheUpdateShowsItsProgressAndResult() throws {
        let app = launchIntoMachine()
        let name = try machineName(app)
        let software = element(app, "machine.software")
        // Rename sits at the foot of the page; Software is above it.
        for _ in 0..<6 where !software.isHittable { app.swipeDown() }
        for _ in 0..<6 where !software.isHittable { app.swipeUp() }
        XCTAssertTrue(software.waitForExistence(timeout: 20))
        // The fixture applies its one update for good: a second run on it finds nothing to install.
        try XCTSkipUnless(software.label.contains("0.0.19 is available"),
                          "The fixture already updated to 0.0.19. Restart `bun run spike:daemon` to run this test again.")
        XCTAssertTrue(app.buttons["machine.software.idle"].exists)
        screenshot("machine-software")
        app.buttons["machine.software.now"].tap()
        let confirm = app.buttons["machine.software.now.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Update now asks first")
        XCTAssertTrue(app.staticTexts["Update \(name) now?"].exists, "the question names the machine")
        confirm.tap()
        XCTAssertTrue(app.buttons["machine.software.cancel"].waitForExistence(timeout: 10), "a running update can be cancelled")
        screenshot("machine-software-updating")
        let done = expectation(for: NSPredicate(format: "label CONTAINS 'ace 0.0.19'"), evaluatedWith: software)
        wait(for: [done], timeout: 40)
        screenshot("machine-software-updated")
    }

    func testBrowserSettingsReadInTheWebsWordsAndSaveOnTheMachine() throws {
        let app = launchIntoMachine()
        open(app, "machine.settings.Browser")
        let profile = element(app, "setting.browser.profile")
        XCTAssertTrue(profile.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["When the desktop app goes away"].exists)
        XCTAssertTrue(element(app, "setting.browser.downloadDir.note").exists, "the downloads folder says where empty saves")
        screenshot("browser-settings")
        let fresh = app.buttons["Private"]
        XCTAssertTrue(fresh.waitForExistence(timeout: 10))
        fresh.tap()
        XCTAssertTrue(fresh.wait(for: \.isSelected, toEqual: true, timeout: 10))
        // Read again from the machine: the choice was saved there.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        open(app, "machine.settings.Browser")
        XCTAssertTrue(app.buttons["Private"].wait(for: \.isSelected, toEqual: true, timeout: 15))
        app.buttons["Keep sign-ins"].tap()
    }

    func testConnectAnAppListsAddressesAndSwitchesTheRelayOnTheMachine() throws {
        let app = launchIntoMachine()
        open(app, "machine.connectedApps")
        let local = element(app, "connect.address.local")
        for _ in 0..<6 where !local.isHittable { app.swipeUp() }
        XCTAssertTrue(local.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["connect.address.local.copy"].exists, "a serving address can be copied")
        XCTAssertTrue(app.buttons["connect.enroll.copy"].exists, "the enroll command shows")
        let relay = app.switches["connect.address.relay.switch"].firstMatch
        for _ in 0..<6 where !relay.isHittable { app.swipeUp() }
        XCTAssertTrue(relay.waitForExistence(timeout: 10))
        XCTAssertEqual(relay.value as? String, "0")
        screenshot("connect-an-app")
        relay.switches.firstMatch.tap()
        let on = expectation(for: NSPredicate(format: "value == '1'"), evaluatedWith: relay)
        wait(for: [on], timeout: 15)
        // Read again from the machine: the switch was saved there.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        open(app, "machine.connectedApps")
        let again = app.switches["connect.address.relay.switch"].firstMatch
        for _ in 0..<6 where !again.isHittable { app.swipeUp() }
        XCTAssertTrue(again.waitForExistence(timeout: 15))
        XCTAssertEqual(again.value as? String, "1")
        again.switches.firstMatch.tap()
        let off = expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: again)
        wait(for: [off], timeout: 15)
    }

    private func launchIntoMachine() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841", "-ace.appearance", "dark"]
        app.launch()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 25))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        app.openBrowseDestination("inbox.machines")
        let row = element(app, "machines.row.ios-spike-host")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        return app
    }
    /// The machine's name as its page has it (the fixture takes its host's), from Rename's title.
    private func machineName(_ app: XCUIApplication) throws -> String {
        open(app, "machine.rename")
        let alert = app.alerts.matching(NSPredicate(format: "label BEGINSWITH 'Rename '")).firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        let name = String(alert.label.dropFirst("Rename ".count))
        alert.buttons["Cancel"].tap()
        return try XCTUnwrap(name.isEmpty ? nil : name, "Rename names the machine")
    }
    /// Rename's alert: its field doesn't carry an identifier, so it is the alert's only field.
    private func rename(_ app: XCUIApplication, to name: String, from current: String) {
        open(app, "machine.rename")
        let alert = app.alerts["Rename \(current)"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.staticTexts["Every device shows this name."].exists, "the alert says where the name goes")
        let field = alert.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.clearAndType(name)
        alert.buttons["Save"].firstMatch.tap()
    }
    private func open(_ app: XCUIApplication, _ id: String) {
        let link = app.buttons[id]
        for _ in 0..<6 where !link.isHittable { app.swipeUp() }
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-care-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("care-\(name).png"))
        }
    }
}
