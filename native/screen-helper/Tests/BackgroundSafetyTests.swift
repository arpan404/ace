import XCTest
import ApplicationServices
@testable import ScreenHelper

final class BackgroundSafetyTests: XCTestCase {
    @MainActor func testHumanCursorAndUnrelatedFocusChangesDoNotTurnSuccessIntoFailure() {
        var desktop = FocusState(pid: 42, cursor: .zero)
        let guardState = FocusGuard(targetPID: 99, runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }))
        desktop = FocusState(pid: 43, cursor: CGPoint(x: 10, y: 20))
        XCTAssertNil(guardState.warning())
    }
    @MainActor func testAceTargetActivationRestoresThePreviousApplication() {
        var desktop = FocusState(pid: 42, cursor: .zero)
        let guardState = FocusGuard(targetPID: 99, runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }, restore: { before, _ in desktop = before }))
        desktop = FocusState(pid: 99, cursor: CGPoint(x: 10, y: 20))
        XCTAssertNotNil(guardState.warning())
        XCTAssertEqual(desktop.pid, 42)
    }
    @MainActor func testConcurrentHumanActivationIsNeverAttributedToAce() {
        var desktop = FocusState(pid: 42, cursor: .zero)
        let guardState = FocusGuard(targetPID: 99, runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in true }, restore: { before, _ in desktop = before }))
        desktop = FocusState(pid: 99, cursor: CGPoint(x: 10, y: 20))
        XCTAssertNil(guardState.warning())
        XCTAssertEqual(desktop.pid, 99)
    }
    @MainActor func testRaisingTheTargetWindowWithinTheFrontmostAppWarns() {
        let first = AXUIElementCreateApplication(42), target = AXUIElementCreateApplication(43)
        var desktop = FocusState(pid: 42, cursor: .zero, window: first)
        let guardState = FocusGuard(targetPID: 42, targetWindow: target, runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }, restore: { before, _ in desktop = before }))
        desktop = FocusState(pid: 42, cursor: .zero, window: target)
        XCTAssertNotNil(guardState.warning())
        XCTAssertEqual(desktop.window, first)
    }
    func testBackgroundTrackingMenusRefuseBeforeDispatchButOrdinaryButtonsRemainUsable() throws {
        for role in ["AXPopUpButton", "AXMenuButton", "AXMenuBarItem", "AXMenuItem"] {
            XCTAssertThrowsError(try requireMenuConsent(mode: "background", action: "press", role: role))
        }
        XCTAssertThrowsError(try requireMenuConsent(mode: nil, action: "performSecondaryAction", secondary: "AXShowMenu"))
        XCTAssertThrowsError(try requireMenuConsent(mode: "background", action: "menu.press"))
        try requireMenuConsent(mode: "background", action: "press", role: "AXButton")
        try requireMenuConsent(mode: "foreground", action: "press", role: "AXPopUpButton")
    }
    @MainActor func testBackgroundLaunchKeepsWindowsVisibleWithoutActivating() async throws {
        let guardState = FocusGuard(runtime: FocusRuntime(read: { FocusState(pid: 42, cursor: .zero) }, uptime: { 1 }, humanInput: { _ in false }))
        var visible = false, activated = false
        _ = try await backgroundLaunch(at: URL(fileURLWithPath: "/tmp/disposable-app"), guardState: guardState, wait: {}, open: { _, configuration in
            visible = !configuration.hides; activated = configuration.activates
            return 1
        })
        XCTAssertTrue(visible); XCTAssertFalse(activated)
    }
    func testBusyInspectionsCanFinishWithoutExtendingSubsequentInputChecks() throws {
        var budget: Float = 0.05
        func busyRead() throws -> String {
            if budget < 0.12 { throw HelperError("Busy app timed out", code: "timeout") }
            return "Window contents"
        }
        let tree = try withInspectionTimeout(install: { budget = $0 }, read: busyRead)
        XCTAssertEqual(tree, "Window contents")
        XCTAssertThrowsError(try busyRead())
        XCTAssertThrowsError(try withInspectionTimeout(install: { budget = $0 }, read: { throw HelperError("Target gone", code: "target_gone") }))
        XCTAssertThrowsError(try busyRead())
    }
    @MainActor func testPasteExposesTextThenRestoresEveryClipboardRepresentation() async throws {
        let original = [ClipboardItem(types: ["text": Data("old".utf8), "custom": Data([1, 2, 3])])]
        var items = original, change = 7, destination = ""
        let board = ClipboardBoard(change: { change }, read: { items }, write: { next in items = next; change += 1; return true })
        try await clipboardPaste("new", board: board, wait: {}) { destination = String(data: items[0].types["public.utf8-plain-text"] ?? Data(), encoding: .utf8) ?? "" }
        XCTAssertEqual(destination, "new")
        XCTAssertEqual(items, original)
    }
    @MainActor func testPasteNeverOverwritesAHumanCopyDuringItsBoundedWait() async throws {
        var items = [ClipboardItem(types: ["text": Data("old".utf8)])], change = 7
        let human = [ClipboardItem(types: ["text": Data("human".utf8)])]
        let board = ClipboardBoard(change: { change }, read: { items }, write: { next in items = next; change += 1; return true })
        do {
            try await clipboardPaste("new", board: board, wait: { items = human; change += 1 }, post: {})
            XCTFail("Concurrent copy must be reported")
        } catch { XCTAssertEqual(items, human) }
    }
}
