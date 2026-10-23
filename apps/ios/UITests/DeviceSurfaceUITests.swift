import XCTest

/// Swipes on a device's live screen drive the device; they never take ace back a page.
/// Runs on the spike fixture (`bun run spike:daemon`); `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class DeviceSurfaceUITests: XCTestCase {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"

    override func setUp() { continueAfterFailure = false }

    func testRightSwipeOnTheDeviceScreenGoesToTheDeviceNotBack() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        app.openBrowseDestination("library.devices")
        let row = app.buttons["devices.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        let control = app.buttons["devices.control"]
        XCTAssertTrue(control.waitForExistence(timeout: 20))
        if control.label == "Take over" {
            control.tap()
            let driving = expectation(for: NSPredicate(format: "label != %@", "Take over"), evaluatedWith: control)
            await fulfillment(of: [driving], timeout: 10)
        }
        let surface = app.descendants(matching: .any)["devices.surface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["devices.home"].isEnabled, "The person should be driving the device")
        let before = try await rightSwipes()

        // From the surface's left edge, where the back swipe starts, and from its middle.
        for start in [0.02, 0.4] {
            surface.coordinate(withNormalizedOffset: CGVector(dx: start, dy: 0.5))
                .press(forDuration: 0.05, thenDragTo: surface.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)),
                       withVelocity: .fast, thenHoldForDuration: 0)
            try await Task.sleep(for: .seconds(1))
            XCTAssertTrue(surface.exists, "A swipe on the device's screen took ace back")
            XCTAssertTrue(control.exists)
        }

        // The device received both swipes.
        var after = before
        for _ in 0..<20 where after < before + 2 {
            try await Task.sleep(for: .milliseconds(250))
            after = try await rightSwipes()
        }
        XCTAssertEqual(after, before + 2, "Both swipes should reach the device")
    }

    /// Rightward swipes the fixture's devices have received from a person.
    private func rightSwipes() async throws -> Int {
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/devices/inputs"))
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(Inputs.self, from: data).inputs
            .filter { $0.input.kind == "swipe" && ($0.input.toX ?? 0) > ($0.input.x ?? 0) }.count
    }
}

private struct Inputs: Decodable {
    struct Entry: Decodable { let input: Input }
    struct Input: Decodable { let kind: String; let x: Double?; let toX: Double? }
    let inputs: [Entry]
}
