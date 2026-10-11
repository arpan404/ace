import XCTest
import CoreFoundation
@testable import ScreenHelper

final class AccessibilityTextTests: XCTestCase {
    func testEmojiTitlesAndDescriptionsFitTheWireLimitWithoutBreakingGraphemes() {
        let family = "👨‍👩‍👧‍👦"
        let input = String(repeating: family, count: 40)
        let result = axText(input as CFString, cap: 128) ?? ""
        XCTAssertLessThanOrEqual(result.unicodeScalars.count, 256)
        XCTAssertTrue(boundedAXText(input as CFString, cap: 128).truncated)
        XCTAssertEqual(result, String(repeating: family, count: 18))
    }
    func testCombiningSequencesFitTheCapAndOrdinaryTitlesKeepTheirContent() {
        let cluster = "a" + String(repeating: "\u{301}", count: 200)
        XCTAssertEqual(axText(cluster as CFString, cap: 128), "")
        XCTAssertFalse(boundedAXText("A normal title" as CFString, cap: 128).truncated)
        XCTAssertEqual(axText("A normal title" as CFString, cap: 128), "A normal title")
        XCTAssertEqual(axText(String(repeating: "x", count: 129) as CFString, cap: 128)?.count, 128)
    }
}
