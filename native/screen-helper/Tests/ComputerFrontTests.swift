import XCTest
@testable import ScreenHelper

/// A desktop whose frontmost app the test moves, with the person idle unless told otherwise.
@MainActor private final class Desktop {
    var front: pid_t? = 42
    var idleSeconds = 60.0
    var clock = 100.0
    var refuses = false
    var system: CUFrontSystem {
        CUFrontSystem(frontmost: { self.front }, secondsSinceHumanInput: { self.idleSeconds }, uptime: { self.clock },
                      restore: { pid in if self.refuses { return false }; self.front = pid; return true }, name: { $0 == 42 ? "Notes" : "app \($0)" })
    }
}

final class ComputerFrontTests: XCTestCase {
    @MainActor func testATargetThatTakesTheFrontIsSentBackAndTheStepSaysSo() {
        let desktop = Desktop()
        let front = CUFrontGuard(system: desktop.system)
        desktop.clock += 0.3
        desktop.front = 99
        let note = front.check(target: 99, app: "Calculator")
        XCTAssertEqual(desktop.front, 42)
        XCTAssertEqual(note, "Calculator brought itself to the front; Notes was put back in front")
    }

    @MainActor func testAStepThatLeavesThePersonsAppInFrontReportsNothing() {
        let desktop = Desktop()
        let front = CUFrontGuard(system: desktop.system)
        desktop.clock += 0.3
        XCTAssertNil(front.check(target: 99, app: "Calculator"))
        XCTAssertEqual(desktop.front, 42)
    }

    @MainActor func testThePersonSwitchingToTheTargetThemselvesIsLeftAlone() {
        let desktop = Desktop()
        let front = CUFrontGuard(system: desktop.system)
        desktop.clock += 0.3
        desktop.idleSeconds = 0.1
        desktop.front = 99
        XCTAssertNil(front.check(target: 99, app: "Calculator"))
        XCTAssertEqual(desktop.front, 99)
    }

    @MainActor func testAnotherAppComingForwardIsNotTheEnginesDoing() {
        let desktop = Desktop()
        let front = CUFrontGuard(system: desktop.system)
        desktop.front = 7
        XCTAssertNil(front.check(target: 99, app: "Calculator"))
        XCTAssertEqual(desktop.front, 7)
    }

    @MainActor func testATargetAlreadyInFrontStaysThere() {
        let desktop = Desktop()
        desktop.front = 99
        let front = CUFrontGuard(system: desktop.system)
        XCTAssertNil(front.check(target: 99, app: "Calculator"))
        XCTAssertEqual(desktop.front, 99)
    }

    @MainActor func testARefusedRestoreIsReportedRatherThanClaimedFixed() {
        let desktop = Desktop()
        desktop.refuses = true
        let front = CUFrontGuard(system: desktop.system)
        desktop.front = 99
        XCTAssertEqual(front.check(target: 99, app: "Calculator"), "Calculator brought itself to the front and macOS would not put Notes back")
    }
}
