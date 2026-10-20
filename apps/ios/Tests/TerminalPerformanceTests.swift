import XCTest
@testable import Ace

/// Simulator-only cost of rebuilding the bounded, selectable terminal text after a small delta.
/// This does not measure GPU frames, keyboard delivery or physical-device performance.
@MainActor final class TerminalPerformanceTests: XCTestCase {
    func testSmallUpdatesToAThousandLineSelectableTerminal() {
        var buffer = TerminalBuffer()
        buffer.feed(String(repeating: String(repeating: "a", count: 79) + "\r\n", count: 1000))
        var visible = ""
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            for _ in 0..<200 {
                buffer.feed("\rupdated\u{1b}[K")
                visible = buffer.text
            }
        }
        XCTAssertTrue(visible.hasSuffix("updated"))
        XCTAssertLessThanOrEqual(visible.count, 81_000)
    }
}
