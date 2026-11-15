import XCTest
import UIKit

/// Settings › Appearance's Look grid against the spike fixture's Suits (`scripts/suits-scenario.ts`:
/// Tarn, Mizzle and Static, which fails its checks). Picking Tarn must recolour the open sheet,
/// Static can't be picked, and a theme card must bring the theme back.
@MainActor final class AppearanceSuitsUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testASuitFromTheLookGridRecoloursThePhoneAndAThemeTakesItOff() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launchWithArguments()
        defer { app.terminate() }
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.dark"].waitForExistence(timeout: 10))
        app.tapScrolled("appearance.dark")
        app.tapScrolled("appearance.theme.ace")
        XCTAssertTrue(waitForPage { $0.blue - $0.red < 3 }, "ace's dark page is neutral")
        screenshot("look-grid-ace")

        let tarn = app.buttons["appearance.suit.tarn"]
        XCTAssertTrue(tarn.waitForExistence(timeout: 20), "the machine's Suits join the Look grid")
        // Static fails its checks: it is listed but can't be picked.
        app.reveal(app.buttons["appearance.suit.static"])
        XCTAssertTrue(app.buttons["appearance.suit.static"].exists)
        XCTAssertFalse(app.buttons["appearance.suit.static"].isEnabled)

        app.reveal(tarn)
        tarn.tap()
        // A tap that lands while the page still glides only stops it.
        if !tarn.waitForSelection(timeout: 3) { tarn.tap() }
        // Tarn's dark page is a cool blue-black, #16181B.
        XCTAssertTrue(waitForPage { $0.blue - $0.red >= 3 && $0.red < 40 }, "Tarn recolours the open sheet")
        XCTAssertTrue(tarn.isSelected)
        screenshot("look-grid-tarn")
        let backdrop = app.segmentedControls["appearance.backdrop"]
        app.reveal(backdrop)
        XCTAssertTrue(backdrop.exists, "Tarn's still offers the Backdrop setting")
        screenshot("look-grid-tarn-lower")

        // The inbox behind the sheet wears Tarn, over its still.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.closeSheet()
        let row = app.buttons["thread.ios-spike-host-\(port).ios-approval"]
        if row.waitForExistence(timeout: 20) { screenshot("tarn-inbox"); row.tap() }
        if app.descendants(matching: .any)["transcript"].firstMatch.waitForExistence(timeout: 20) { screenshot("tarn-thread") }

        // A theme card takes the Suit off, and the way back puts Tarn on again.
        app.terminate()
        app.launchWithArguments()
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.theme.ace"].waitForExistence(timeout: 10))
        // Tarn is kept on this phone: it is on before any machine answers.
        XCTAssertTrue(waitForPage { $0.blue - $0.red >= 3 && $0.red < 40 }, "Tarn holds through a relaunch")
        app.tapScrolled("appearance.theme.ace")
        XCTAssertTrue(waitForPage { $0.blue - $0.red < 3 && $0.red < 30 }, "ace's theme comes back")
        app.reveal(app.buttons["appearance.revertLook"])
        XCTAssertTrue(app.buttons["appearance.revertLook"].exists)
        screenshot("look-grid-back")
        app.tapScrolled("appearance.revertLook")
        XCTAssertTrue(waitForPage { $0.blue - $0.red >= 3 && $0.red < 40 }, "Back to Tarn puts it on again")
        app.tapScrolled("appearance.theme.ace")
        app.tapScrolled("appearance.system")
    }

    private struct Pixel { let red: Int; let green: Int; let blue: Int }

    /// The page's own background, left of the inset rows.
    private func waitForPage(_ matches: (Pixel) -> Bool) -> Bool {
        for _ in 0..<40 {
            if let pixel = pixel(of: XCUIScreen.main.screenshot().image, at: CGPoint(x: 0.015, y: 0.55)), matches(pixel) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func pixel(of image: UIImage, at unit: CGPoint) -> Pixel? {
        guard let cg = image.cgImage else { return nil }
        var bytes = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let x = CGFloat(cg.width) * unit.x, y = CGFloat(cg.height) * (1 - unit.y)
        context.draw(cg, in: CGRect(x: -x, y: -y, width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return Pixel(red: Int(bytes[0]), green: Int(bytes[1]), blue: Int(bytes[2]))
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-suits-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("suits-\(name).png"))
        }
    }
}

private extension XCUIElement {
    @MainActor func waitForSelection(timeout: TimeInterval) -> Bool {
        let selected = NSPredicate(format: "isSelected == true")
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: selected, object: self)], timeout: timeout) == .completed
    }
}
