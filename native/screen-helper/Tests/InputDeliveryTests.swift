import XCTest
import ScreenCaptureKit
import AppKit
@testable import ScreenHelper

final class InputDeliveryTests: XCTestCase {
    func testBackgroundTypingRetainsTheSelectedSimulatorWindowAndUnicode() throws {
        let event = try windowKeyEvent(.keyDown, windowId: 42, character: "é", keyCode: 0, modifiers: [], timestamp: 1)
        var window: Int?, text: String?
        try deliverInput(event, mode: "background", pid: 99, permission: { true }) { posted, destination in
            XCTAssertEqual(destination, .process(99))
            let key = NSEvent(cgEvent: posted)
            window = key?.windowNumber; text = key?.characters
        }
        XCTAssertEqual(window, 42)
        XCTAssertEqual(text, "é")
    }
    func testForegroundKeysStopBeforePostingWhenTheHumanChangesAppOrWindow() throws {
        var posted: [String] = []
        func send(_ name: String, pid: pid_t?, window: UInt32?) throws {
            try verifyKeyboardDestination(expectedPID: 42, expectedWindow: 7, actualPID: pid, actualWindow: window)
            posted.append(name)
        }
        try send("down", pid: 42, window: 7)
        XCTAssertThrowsError(try send("up", pid: 43, window: 7))
        XCTAssertThrowsError(try send("next", pid: 42, window: 8))
        XCTAssertEqual(posted, ["down"])
    }
    func testBackgroundUnicodeIsDeliveredOnlyToTheSelectedProcess() throws {
        let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        let units = Array("こんにちは 👋".utf16)
        units.withUnsafeBufferPointer { if let base = $0.baseAddress { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base) } }
        var delivered: EventDestination?, text = ""
        try deliverInput(event, mode: "background", pid: 42, permission: { true }) { received, destination in
            delivered = destination
            var length = 0
            var buffer = [UniChar](repeating: 0, count: 64)
            received.keyboardGetUnicodeString(maxStringLength: 64, actualStringLength: &length, unicodeString: &buffer)
            text = String(utf16CodeUnits: buffer, count: length)
        }
        XCTAssertEqual(delivered, .process(42))
        XCTAssertEqual(text, "こんにちは 👋")
    }
    func testForegroundInputRequiresAnExplicitModeAndPermission() throws {
        let event = try XCTUnwrap(CGEvent(source: nil))
        var delivered: EventDestination?
        XCTAssertThrowsError(try deliverInput(event, mode: "foreground", pid: 42, permission: { false }) { _, destination in delivered = destination })
        XCTAssertNil(delivered)
        try deliverInput(event, mode: "foreground", pid: 42, permission: { true }) { _, destination in delivered = destination }
        XCTAssertEqual(delivered, .foreground)
    }
    @MainActor func testBackgroundLaunchPreservesTheHumanApplication() async throws {
        let original = FocusState(pid: 42, cursor: .zero)
        var desktop = original
        let guardState = FocusGuard(runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }))
        let launched = try await backgroundLaunch(at: URL(fileURLWithPath: "/unused"), guardState: guardState, wait: {}, open: { _, configuration in
            if configuration.activates { desktop = FocusState(pid: 99, cursor: .zero) }
            return configuration.hides ? "hidden" : "visible"
        })
        XCTAssertEqual(launched, "hidden")
        XCTAssertEqual(desktop, original)
    }
    func testObservationWaitReturnsTheChangedUIAfterNotificationsSettle() async throws {
        var text = "old", revision: UInt64 = 0
        let observed = try await settledObservation(wait: { if text == "old" { text = "changed"; revision += 1 } }, revision: { revision }, observe: { text })
        XCTAssertEqual(observed, "changed")
    }
    func testReleasingAHeldForegroundPressUsesItsOriginalModeAfterTakeover() throws {
        struct Press { let mode: String; let pid: pid_t }
        let held = HeldPointer<Press>()
        held.hold(Press(mode: "foreground", pid: 42))
        let event = try XCTUnwrap(CGEvent(source: nil))
        var release: EventDestination?
        try held.release { original in
            try deliverInput(event, mode: original.mode, pid: original.pid, permission: { true }) { _, destination in release = destination }
        }
        XCTAssertEqual(release, .foreground)
        XCTAssertNil(held.target)
    }

    func testCaptureRestartsSystemInterruptionsButHonoursUserCancellationAndPermissionDenial() {
        XCTAssertTrue(recoverableCaptureError(NSError(domain: SCStreamError.errorDomain, code: SCStreamError.failedApplicationConnectionInterrupted.rawValue)))
        XCTAssertFalse(recoverableCaptureError(NSError(domain: SCStreamError.errorDomain, code: SCStreamError.userDeclined.rawValue)))
        if #available(macOS 14.0, *) { XCTAssertFalse(recoverableCaptureError(NSError(domain: SCStreamError.errorDomain, code: SCStreamError.userStopped.rawValue))) }
        XCTAssertFalse(recoverableCaptureError(NSError(domain: "other", code: SCStreamError.internalError.rawValue)))
    }

}
