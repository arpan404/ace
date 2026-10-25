import XCTest
import CoreGraphics
@testable import ScreenHelper

final class WindowContentTests: XCTestCase {
    private let window = CGRect(x: 100, y: 50, width: 440, height: 960)

    func testASimulatorWindowLosesItsTitleBarAndToolbar() {
        // Window buttons 7 points down, a toolbar under them reaching 52 points into the window.
        let parts = [CGRect(x: 107, y: 57, width: 14, height: 16), CGRect(x: 100, y: 50, width: 440, height: 52)]
        XCTAssertEqual(titleBarDepth(window: window, parts: parts), 52)
        XCTAssertEqual(contentBounds(window, inset: 52), CGRect(x: 100, y: 102, width: 440, height: 908))
    }
    func testAWindowWithNoTitleBarIsKeptWhole() {
        XCTAssertEqual(titleBarDepth(window: window, parts: []), 0)
        XCTAssertEqual(contentBounds(window, inset: 0), window)
    }
    func testPartsBelowTheTopOrTooDeepNeverCropTheDevice() {
        // A side button halfway down, and a "toolbar" covering half the window, are not a title bar.
        XCTAssertEqual(titleBarDepth(window: window, parts: [CGRect(x: 530, y: 500, width: 10, height: 80)]), 0)
        XCTAssertEqual(titleBarDepth(window: window, parts: [CGRect(x: 100, y: 50, width: 440, height: 480)]), 0)
    }
}
