import XCTest
@testable import ScreenHelper

@MainActor final class Gate {
    var continuation: CheckedContinuation<Void, Never>?
    var opened = false
    func wait() async { if !opened { await withCheckedContinuation { continuation = $0 } } }
    func open() { opened = true; continuation?.resume(); continuation = nil }
}
final class CommandSchedulerTests: XCTestCase {
    @MainActor func testIndependentAppsFinishWhileAnotherAppWaitsAndItsOwnActionsStayOrdered() async {
        let scheduler = CommandScheduler(), blocked = Gate(), reached = Gate(), other = Gate()
        var effects: [String] = []
        XCTAssertTrue(scheduler.submit(key: "a", coordinated: false) { reached.open(); await blocked.wait(); effects.append("a1") })
        XCTAssertTrue(scheduler.submit(key: "a", coordinated: false) { effects.append("a2") })
        await reached.wait()
        XCTAssertTrue(scheduler.submit(key: "b", coordinated: false) { effects.append("b"); other.open() })
        await other.wait()
        XCTAssertEqual(effects, ["b"])
        blocked.open(); await scheduler.drain()
        XCTAssertEqual(effects, ["b", "a1", "a2"])
    }
    @MainActor func testForegroundAndClipboardEffectsNeverOverlapAcrossApps() async {
        let scheduler = CommandScheduler(), blocked = Gate(), reached = Gate()
        var effects: [String] = []
        XCTAssertTrue(scheduler.submit(key: "a", coordinated: true) { effects.append("first"); reached.open(); await blocked.wait(); effects.append("end") })
        await reached.wait()
        XCTAssertTrue(scheduler.submit(key: "b", coordinated: true) { effects.append("second") })
        blocked.open(); await scheduler.drain()
        XCTAssertEqual(effects, ["first", "end", "second"])
    }
}
