import XCTest
import UIKit

/// Settings › Appearance themes and accents against the spike fixture (`bun run spike:daemon`,
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for another port). A theme must recolour the open sheet and
/// the screens behind it, and going back to ace must bring back the neutral page.
@MainActor final class AppearanceThemesUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testAThemeRecoloursTheOpenSheetAndAceRestoresTheNeutralPage() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        defer { app.terminate() }
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.dark"].waitForExistence(timeout: 10))
        app.buttons["appearance.dark"].tap()
        app.buttons["appearance.theme.ace"].tap()
        app.buttons["appearance.accent.theme"].tap()
        XCTAssertTrue(waitForPage { $0.blue - $0.red < 3 }, "ace's dark page is neutral")
        screenshot("dark-ace")

        // Midnight's dark page is a blue-black.
        app.buttons["appearance.theme.midnight"].tap()
        XCTAssertTrue(waitForPage { $0.blue - $0.red >= 8 }, "Midnight turns the open sheet blue-black")
        app.buttons["appearance.accent.teal"].tap()
        XCTAssertTrue(app.buttons["appearance.accent.teal"].isSelected)
        screenshot("dark-midnight-teal")
        app.swipeUp()
        screenshot("dark-midnight-lower")
        app.swipeDown()

        // Paper's light page is warm cream.
        app.buttons["appearance.light"].tap()
        app.buttons["appearance.theme.paper"].tap()
        app.buttons["appearance.accent.theme"].tap()
        XCTAssertTrue(waitForPage { $0.red - $0.blue >= 6 && $0.red > 240 }, "Paper turns the open sheet cream")
        screenshot("light-paper")
        app.swipeUp()
        screenshot("light-paper-lower")
        app.swipeDown()

        // The screens behind the sheet take the theme too.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.closeSheet()
        let row = app.buttons["thread.ios-spike-host-\(port).ios-approval"]
        if row.waitForExistence(timeout: 20) { screenshot("light-paper-inbox"); row.tap() }
        if app.descendants(matching: .any)["transcript"].firstMatch.waitForExistence(timeout: 20) { screenshot("light-paper-thread") }

        // Back to ace with its own accent: the neutral page returns.
        app.terminate()
        app.launch()
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.theme.ace"].waitForExistence(timeout: 10))
        app.buttons["appearance.theme.ace"].tap()
        app.buttons["appearance.dark"].tap()
        XCTAssertTrue(waitForPage { $0.blue - $0.red < 3 && $0.red < 30 }, "ace restores the neutral dark page")
        app.buttons["appearance.system"].tap()
    }

    private struct Pixel { let red: Int; let green: Int; let blue: Int }

    /// The page's own background, left of the inset rows.
    private func waitForPage(_ matches: (Pixel) -> Bool) -> Bool {
        for _ in 0..<24 {
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
        attachment.name = "ios-appearance-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("appearance-\(name).png"))
        }
    }
}
