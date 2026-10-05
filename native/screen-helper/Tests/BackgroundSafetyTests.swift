import XCTest
import ApplicationServices
@testable import ScreenHelper

final class BackgroundSafetyTests: XCTestCase {
    @MainActor func testChangingTheHumansFocusedFieldIsReportedAndRestored() throws {
        let first = AXUIElementCreateApplication(42), second = AXUIElementCreateApplication(43)
        let original = FocusState(pid: 42, cursor: CGPoint(x: 10, y: 20), window: first, element: first)
        var desktop = original
        let guardState = FocusGuard(runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }, restore: { before, _ in desktop = before }))
        desktop = FocusState(pid: 42, cursor: original.cursor, window: first, element: second)
        XCTAssertThrowsError(try guardState.verify())
        XCTAssertEqual(desktop, original)
    }
    @MainActor func testActivationAndCursorWarpAreRestoredAfterAnAction() throws {
        let original = FocusState(pid: 42, cursor: CGPoint(x: 10, y: 20))
        var desktop = original
        let guardState = FocusGuard(runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in false }, restore: { before, _ in desktop = before }))
        desktop = FocusState(pid: 99, cursor: CGPoint(x: 50, y: 60))
        XCTAssertThrowsError(try guardState.verify())
        XCTAssertEqual(desktop, original)
    }
    @MainActor func testConcurrentHumanInputIsNeverUndoneByRestoration() throws {
        var desktop = FocusState(pid: 42, cursor: .zero)
        let guardState = FocusGuard(runtime: FocusRuntime(read: { desktop }, uptime: { 1 }, humanInput: { _ in true }, restore: { before, _ in desktop = before }))
        let human = FocusState(pid: 99, cursor: CGPoint(x: 10, y: 20))
        desktop = human
        XCTAssertThrowsError(try guardState.verify())
        XCTAssertEqual(desktop, human)
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
