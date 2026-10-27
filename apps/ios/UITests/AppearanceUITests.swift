import XCTest
import UIKit

/// Settings › Appearance against the spike fixture (`bun run spike:daemon`). The choice must
/// re-style the Settings sheet it is picked from, not only the screens behind it.
@MainActor final class AppearanceUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testPickingLightOrDarkRestylesTheOpenSettingsSheet() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        defer { app.terminate() }
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.dark"].waitForExistence(timeout: 10))
        defer { app.buttons["appearance.system"].tap() }

        app.buttons["appearance.dark"].tap()
        XCTAssertTrue(waitForSheet(brightness: { $0 < 0.3 }), "Dark turns the open sheet dark")
        screenshot("dark")

        app.buttons["appearance.light"].tap()
        XCTAssertTrue(waitForSheet(brightness: { $0 > 0.7 }), "Light turns the open sheet light")
        screenshot("light")

        app.buttons["appearance.dark"].tap()
        XCTAssertTrue(waitForSheet(brightness: { $0 < 0.3 }), "Dark again turns it back")
    }

    /// The empty sheet background below the three mode rows.
    private func waitForSheet(brightness matches: (Double) -> Bool) -> Bool {
        for _ in 0..<20 {
            if let value = brightness(of: XCUIScreen.main.screenshot().image, at: CGPoint(x: 0.5, y: 0.8)), matches(value) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    private func brightness(of image: UIImage, at unit: CGPoint) -> Double? {
        guard let cg = image.cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let x = CGFloat(cg.width) * unit.x, y = CGFloat(cg.height) * (1 - unit.y)
        context.draw(cg, in: CGRect(x: -x, y: -y, width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return (Double(pixel[0]) + Double(pixel[1]) + Double(pixel[2])) / (3 * 255)
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-appearance-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
