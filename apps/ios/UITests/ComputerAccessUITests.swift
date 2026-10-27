import XCTest

/// Computer use and devices on the spike fixture: locked use turned on through the Mac's
/// approval, Use my Chrome installed, and a device shown screen only with its stream stats.
@MainActor final class ComputerAccessUITests: XCTestCase {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        return app
    }
    private func control(_ action: String) async throws {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/browser")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["action": action])
        _ = try await URLSession.shared.data(for: request)
    }

    func testLockedUseAndUseMyChromeAreSetUpFromThePhone() async throws {
        let app = launch()
        app.openBrowseDestination("library.computer")
        let locked = app.switches["computer.locked.switch"]
        XCTAssertTrue(locked.waitForExistence(timeout: 20))
        screenshot("computer-1-off")
        locked.tap()
        let state = app.staticTexts["computer.locked.state"]
        XCTAssertTrue(state.wait(for: \.label, toEqual: "Needs approval", timeout: 10))
        screenshot("computer-2-needs-approval")
        try await control("approve")
        XCTAssertTrue(state.wait(for: \.label, toEqual: "On", timeout: 10))
        screenshot("computer-3-on")

        app.buttons["computer.chrome"].tap()
        let install = app.buttons["computer.chrome.install"]
        XCTAssertTrue(install.waitForExistence(timeout: 15))
        screenshot("computer-4-chrome")
        install.tap()
        XCTAssertTrue(app.descendants(matching: .any)["computer.chrome.extension"].waitForExistence(timeout: 10))
        screenshot("computer-5-chrome-installed")
    }

    func testADeviceShowsScreenOnlyWithItsStreamStats() {
        let app = launch()
        app.openBrowseDestination("library.devices")
        let row = app.buttons["devices.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["devices.surface"].waitForExistence(timeout: 30))
        sleep(2)
        screenshot("devices-1-framed")
        let options = app.buttons["devices.options"]
        options.tap()
        app.buttons.matching(NSPredicate(format: "identifier == 'devices.screenOnly' OR label == 'Screen only'")).firstMatch.tap()
        sleep(1)
        options.tap()
        app.buttons.matching(NSPredicate(format: "identifier == 'devices.streamStats' OR label == 'Stream stats'")).firstMatch.tap()
        let stats = app.descendants(matching: .any)["devices.stats"]
        XCTAssertTrue(stats.waitForExistence(timeout: 10))
        sleep(3)
        screenshot("devices-2-screen-only-stats")
        XCTAssertTrue(stats.label.contains("H.264"), stats.label)
        // Back as it was, for the next run.
        options.tap()
        app.buttons.matching(NSPredicate(format: "identifier == 'devices.screenOnly' OR label == 'Screen only'")).firstMatch.tap()
        options.tap()
        app.buttons.matching(NSPredicate(format: "identifier == 'devices.streamStats' OR label == 'Stream stats'")).firstMatch.tap()
        XCTAssertTrue(stats.waitForNonExistence(timeout: 10))
    }

    private func screenshot(_ name: String) {
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
