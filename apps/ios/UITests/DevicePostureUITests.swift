import XCTest

/// A foldable device's ⋯ menu folds it: the posture the person picks reaches the device and is
/// the one checked next time. Runs on the spike fixture (`bun run spike:daemon`), whose iPhone Duo
/// starts open flat; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class DevicePostureUITests: XCTestCase {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"

    override func setUp() { continueAfterFailure = false }

    func testPickingAPostureFoldsTheDevice() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        app.openBrowseDestination("library.devices")
        let duo = app.buttons.matching(identifier: "devices.row").matching(NSPredicate(format: "label CONTAINS %@", "iPhone Duo")).firstMatch
        XCTAssertTrue(duo.waitForExistence(timeout: 20))
        duo.tap()
        // A device someone else holds is taken first; a free one is the person's to drive.
        let control = app.buttons["devices.control"]
        if control.waitForExistence(timeout: 5), control.label == "Take over" { control.tap() }
        let home = app.buttons["devices.home"]
        XCTAssertTrue(home.waitForExistence(timeout: 20))
        let drivable = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: home)
        await fulfillment(of: [drivable], timeout: 20)

        for (label, posture) in [("Closed", "closed"), ("Half open", "partiallyOpen")] {
            let options = app.buttons["devices.options"]
            XCTAssertTrue(options.waitForExistence(timeout: 10))
            options.tap()
            let rotate = app.buttons["Rotate"].firstMatch
            XCTAssertTrue(rotate.waitForExistence(timeout: 10))
            XCTAssertTrue(rotate.isEnabled, "Rotate should be enabled")
            let menu = app.buttons["Posture"].firstMatch
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "A foldable device's menu should offer its posture")
            menu.tap()
            add(XCTAttachment(screenshot: app.screenshot()))
            let choice = app.buttons[label].firstMatch
            XCTAssertTrue(choice.waitForExistence(timeout: 10))
            let ready = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: choice)
            await fulfillment(of: [ready], timeout: 10)
            choice.tap()
            var folded = ""
            for _ in 0..<20 where folded != posture {
                try await Task.sleep(for: .milliseconds(250))
                folded = try await fold(of: "ios:5e6d3b4c-3f6d-4e5c-9b2a-8d9e0f1a2b3c")
            }
            XCTAssertEqual(folded, posture, "Picking \(label) should fold the device")
        }
    }

    private func fold(of id: String) async throws -> String {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/devices/folds"))
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode([String: [String: String]].self, from: data)["folds"]?[id] ?? ""
    }
}
