import XCTest

/// The browser's device toolbar on the phone, on the spike fixture's checkout page: the page opens
/// as this phone, the menu shows the device toolbar, and a laptop picked there fits the phone's width.
final class BrowserDeviceUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor func testThePageOpensAsThisPhoneAndTheDeviceToolbarPicksALaptop() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        let row = app.buttons["thread.ios-browser"]
        app.bringToMiddle(row)
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 15))
        sleep(3)
        screenshot("browser-device-1-opened")

        app.buttons["browser.menu"].tap()
        let item = app.buttons.matching(NSPredicate(format: "identifier == 'browser.menu.device' OR label BEGINSWITH 'Device'")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        XCTAssertTrue(item.label.contains("This phone"), "the page opened as this phone, not \(item.label)")
        item.tap()
        let size = app.staticTexts["browser.device.size"]
        XCTAssertTrue(size.waitForExistence(timeout: 10))
        screenshot("browser-device-2-toolbar")

        app.buttons["browser.device.menu"].tap()
        let laptop = app.buttons["Laptop"]
        XCTAssertTrue(laptop.waitForExistence(timeout: 10))
        laptop.tap()
        XCTAssertTrue(size.wait(for: \.label, toEqual: "1280 by 800", timeout: 15))
        sleep(3)
        screenshot("browser-device-3-laptop")

        app.buttons["browser.device.rotate"].tap()
        XCTAssertTrue(size.wait(for: \.label, toEqual: "800 by 1280", timeout: 15))
        app.buttons["browser.device.hide"].tap()
        XCTAssertTrue(size.waitForNonExistence(timeout: 10))
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
