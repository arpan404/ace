import XCTest
import IOKit.pwr_mgt
@testable import ScreenHelper

final class ComputerPowerTests: XCTestCase {
    @MainActor func testComputerUsePreventsSystemSleepWithoutRequiringTheDisplayToStayOn() throws {
        let awake = CUAwake()
        defer { awake.release() }
        try awake.hold()
        let assertions = try processAssertions()
        XCTAssertTrue(assertions.contains { ($0[kIOPMAssertionTypeKey] as? String) == "PreventUserIdleSystemSleep" && ($0[kIOPMAssertionLevelKey] as? Int) == 255 })
    }

    @MainActor func testThinkingBetweenCallsKeepsTheSystemAwakeAndExpiryReleasesIt() throws {
        var expire: (() -> Void)?
        let awake = CUAwake(after: { _, run in expire = run; return {} })
        defer { awake.release() }
        try awake.hold()
        try awake.keepDisplayAwake()
        awake.linger()
        var assertions = try processAssertions()
        XCTAssertTrue(assertions.contains { ($0[kIOPMAssertionTypeKey] as? String) == "PreventUserIdleSystemSleep" && ($0[kIOPMAssertionLevelKey] as? Int) == 255 })
        XCTAssertFalse(assertions.contains { ($0[kIOPMAssertionTypeKey] as? String) == "PreventUserIdleDisplaySleep" && ($0[kIOPMAssertionLevelKey] as? Int) == 255 })
        try XCTUnwrap(expire)()
        assertions = try processAssertions()
        XCTAssertFalse(assertions.contains { ($0[kIOPMAssertionNameKey] as? String) == "ace computer use" })
    }

    @MainActor func testReleasingComputerUseRemovesItsSleepProtectionImmediately() throws {
        let awake = CUAwake()
        try awake.hold()
        awake.release()
        awake.release()
        XCTAssertFalse(try processAssertions().contains { ($0[kIOPMAssertionNameKey] as? String) == "ace computer use" })
    }

    @MainActor func testAnOldExpiryCannotReleaseARenewedSession() throws {
        var expiry: (() -> Void)?
        let awake = CUAwake(after: { _, run in expiry = run; return {} })
        defer { awake.release() }
        try awake.hold()
        awake.linger()
        let oldExpiry = try XCTUnwrap(expiry)
        try awake.hold()
        awake.linger()
        oldExpiry()
        XCTAssertTrue(try processAssertions().contains { ($0[kIOPMAssertionTypeKey] as? String) == "PreventUserIdleSystemSleep" && ($0[kIOPMAssertionLevelKey] as? Int) == 255 })
        try XCTUnwrap(expiry)()
        XCTAssertFalse(try processAssertions().contains { ($0[kIOPMAssertionNameKey] as? String) == "ace computer use" })
    }

    private func processAssertions() throws -> [[String: Any]] {
        var result: Unmanaged<CFDictionary>?
        XCTAssertEqual(IOPMCopyAssertionsByProcess(&result), kIOReturnSuccess)
        let dictionary = try XCTUnwrap(result?.takeRetainedValue() as? [NSNumber: [[String: Any]]])
        return dictionary[NSNumber(value: getpid())] ?? []
    }
}
