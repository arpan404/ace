import XCTest

/// Pairing a computer from a fresh install: the scanner's states, the pasted link and the
/// confirm step. No fixture daemon is needed; nothing here pairs for real. `--spike-camera`
/// stands in for the camera the simulator lacks; without it the simulator's own (none) is used.
@MainActor final class PairingUITests: XCTestCase {
    private let link = "https://127.0.0.1:4611/pair#fingerprint=910f1d462b3420fa56b536af54a2a35082154ff832fcced8095103e34dc5eecc"
        + "&code=ef12265409b0b5a3daa4ba0a61fef08c3e1f281c54e5b094534ac0617aee3cae&scopes=read%2Coperate"

    override func setUp() { continueAfterFailure = false }

    func testScanningWithNoCameraStaysOpenAndOffersPaste() {
        let app = openPairing()
        defer { app.terminate() }
        capture("pair")
        app.buttons["pairing.scan"].tap()
        // The simulator has no camera: the scanner says so in place instead of closing.
        XCTAssertTrue(app.descendants(matching: .any)["scanner.unavailable"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["No camera"].exists)
        XCTAssertTrue(app.buttons["scanner.paste"].exists)
        capture("scanner-no-camera")
        app.buttons["scanner.close"].tap()
        XCTAssertTrue(app.buttons["pairing.scan"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["scanner.unavailable"].exists)
    }

    func testCameraAccessOffOffersSettingsAndPaste() {
        let app = openPairing(camera: ["--spike-camera", "denied"])
        defer { app.terminate() }
        app.buttons["pairing.scan"].tap()
        XCTAssertTrue(app.buttons["scanner.settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Camera access is off"].exists)
        XCTAssertTrue(app.buttons["scanner.paste"].exists)
        capture("scanner-denied")
    }

    func testAScannedPairingCodeChecksInAndOpensTheConfirmStep() {
        let app = openPairing(camera: ["--spike-camera", "allowed", "--spike-scan", link])
        defer { app.terminate() }
        app.buttons["pairing.scan"].tap()
        let instruction = app.staticTexts["scanner.instruction"]
        XCTAssertTrue(instruction.waitForExistence(timeout: 10))
        XCTAssertEqual(instruction.label, "Scan the code shown on your computer")
        capture("scanner")
        XCTAssertTrue(app.descendants(matching: .any)["scanner.found"].waitForExistence(timeout: 10))
        capture("scanner-found")
        let fingerprint = app.staticTexts["pairing.fingerprint"]
        XCTAssertTrue(fingerprint.waitForExistence(timeout: 10))
        XCTAssertTrue(fingerprint.label.hasPrefix("910f 1d46 2b34"))
        capture("confirm")
    }

    func testACodeThatIsNotAPairingLinkKeepsTheScannerOpen() {
        let app = openPairing(camera: ["--spike-camera", "allowed", "--spike-scan", "https://example.com/menu"])
        defer { app.terminate() }
        app.buttons["pairing.scan"].tap()
        let instruction = app.staticTexts["scanner.instruction"]
        XCTAssertTrue(instruction.waitForExistence(timeout: 10))
        let changed = NSPredicate(format: "label != %@", "Scan the code shown on your computer")
        expectation(for: changed, evaluatedWith: instruction)
        waitForExpectations(timeout: 10)
        XCTAssertFalse(app.descendants(matching: .any)["scanner.found"].exists)
        XCTAssertTrue(app.buttons["scanner.close"].exists, "the scanner stays up to try another code")
        capture("scanner-wrong-code")
    }

    func testContinueWaitsForALinkAndAMistypedOneSaysWhy() {
        let app = openPairing()
        defer { app.terminate() }
        let next = app.buttons["pairing.continue"]
        XCTAssertFalse(next.isEnabled, "nothing to continue with yet")
        let field = app.textFields["pairing.link"]
        field.tap()
        field.typeText("https://127.0.0.1:4611/pair")
        XCTAssertTrue(next.isEnabled)
        next.tap()
        XCTAssertTrue(app.descendants(matching: .any)["pairing.entryError"].waitForExistence(timeout: 5))
        capture("pair-error")
        field.tap()
        field.typeText(String(link.dropFirst("https://127.0.0.1:4611/pair".count)))
        next.tap()
        XCTAssertTrue(app.staticTexts["pairing.fingerprint"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["pairing.confirm"].isEnabled)
    }

    private func openPairing(camera: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-unpaired"] + camera
        if let appearance = ProcessInfo.processInfo.environment["ACE_SHOT_APPEARANCE"] { app.launchArguments += ["-ace.appearance", appearance] }
        app.launchWithArguments()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        let pair = app.buttons["inbox.empty.pair"]
        XCTAssertTrue(pair.waitForExistence(timeout: 30))
        pair.tap()
        XCTAssertTrue(app.buttons["pairing.scan"].waitForExistence(timeout: 10))
        return app
    }

    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "pairing-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_SHOT_DIR"] {
            let scheme = ProcessInfo.processInfo.environment["ACE_SHOT_APPEARANCE"] ?? "light"
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(scheme).png"))
        }
    }
}
