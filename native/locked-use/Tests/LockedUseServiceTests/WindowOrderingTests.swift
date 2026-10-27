import XCTest
import CoreGraphics
import LockedUseService

final class WindowOrderingTests: XCTestCase {
    let display = CGRect(x: 0, y: 0, width: 100, height: 100)
    let second = CGRect(x: 100, y: 0, width: 100, height: 100)

    func cover(_ rect: CGRect) -> LockedUseWindowFact { LockedUseWindowFact(pid: 10, bounds: rect, alpha: 1) }

    func testFrontmostFullCoversOnEveryDisplayPass() {
        XCTAssertTrue(lockedUseCoversAreFrontmost([cover(display), cover(second)], displays: [display, second],
                                                  coverPID: 10, lockScreenPIDs: []))
    }

    func testAnotherProcessWindowInFrontOfACoverFails() {
        let intruder = LockedUseWindowFact(pid: 99, bounds: CGRect(x: 10, y: 10, width: 5, height: 5), alpha: 1)
        XCTAssertFalse(lockedUseCoversAreFrontmost([intruder, cover(display)], displays: [display], coverPID: 10, lockScreenPIDs: []))
        let invisible = LockedUseWindowFact(pid: 99, bounds: display, alpha: 0)
        XCTAssertTrue(lockedUseCoversAreFrontmost([invisible, cover(display)], displays: [display], coverPID: 10, lockScreenPIDs: []))
    }

    func testTheOSLockScreenMayStayInFrontButAnUncoveredDisplayFails() {
        let shield = LockedUseWindowFact(pid: 77, bounds: display, alpha: 1)
        XCTAssertTrue(lockedUseCoversAreFrontmost([shield, cover(display)], displays: [display], coverPID: 10, lockScreenPIDs: [77]))
        XCTAssertFalse(lockedUseCoversAreFrontmost([cover(display)], displays: [display, second], coverPID: 10, lockScreenPIDs: []))
        XCTAssertFalse(lockedUseCoversAreFrontmost([cover(CGRect(x: 0, y: 0, width: 100, height: 90))], displays: [display],
                                                   coverPID: 10, lockScreenPIDs: []), "A partial cover is not protection")
        XCTAssertFalse(lockedUseCoversAreFrontmost([], displays: [], coverPID: 10, lockScreenPIDs: []))
    }
}
