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
        open(app, "machine.rename")
        let field = app.textFields["machine.rename.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Every device shows this name."].exists, "the alert says where the name goes")
        field.clearAndType("Studio Mac")
        app.buttons["machine.rename.save"].tap()
        XCTAssertTrue(app.navigationBars["Studio Mac"].waitForExistence(timeout: 15), "the page takes the machine's new name")
        screenshot("machine-renamed")
        // Back to the fixture's own name, for the other tests on this fixture.
        open(app, "machine.rename")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.clearAndType("studio")
        app.buttons["machine.rename.save"].tap()
        XCTAssertTrue(app.navigationBars["studio"].waitForExistence(timeout: 15))
    }

    func testStartingTheUpdateShowsItsProgressAndResult() throws {
        let app = launchIntoMachine()
        let software = element(app, "machine.software")
        for _ in 0..<6 where !software.isHittable { app.swipeUp() }
        XCTAssertTrue(software.waitForExistence(timeout: 20))
        XCTAssertTrue(software.label.contains("0.0.19 is available"))
        XCTAssertTrue(app.buttons["machine.software.idle"].exists)
        screenshot("machine-software")
        app.buttons["machine.software.now"].tap()
        let confirm = app.buttons["machine.software.now.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "Update now asks first")
        XCTAssertTrue(app.staticTexts["Update studio now?"].exists)
        confirm.tap()
        XCTAssertTrue(app.buttons["machine.software.cancel"].waitForExistence(timeout: 10), "a running update can be cancelled")
        screenshot("machine-software-updating")
        let done = expectation(for: NSPredicate(format: "label CONTAINS 'ace 0.0.19'"), evaluatedWith: software)
        wait(for: [done], timeout: 40)
        screenshot("machine-software-updated")
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
