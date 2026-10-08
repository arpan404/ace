import XCTest
import AppKit
@testable import ScreenHelper

final class KeyInputTests: XCTestCase {
    func testPunctuationFunctionKeysAndAliasesReachWindowEvents() throws {
        for (name, code) in [("/", UInt16(44)), ("?", 44), ("F5", 96), ("ArrowLeft", 123), ("Esc", 53)] {
            let key = try namedKey(name, modifiers: ["alt", "meta", "super"])
            let flags: NSEvent.ModifierFlags = name == "?" ? [.option, .command, .shift] : [.option, .command]
            let event = try windowKeyEvent(.keyDown, windowId: 42, character: name, keyCode: key.code, modifiers: flags, timestamp: 1)
            XCTAssertEqual(NSEvent(cgEvent: event)?.keyCode, code)
            XCTAssertEqual(NSEvent(cgEvent: event)?.windowNumber, 42)
            XCTAssertTrue(key.modifiers.contains("option"))
            XCTAssertTrue(key.modifiers.contains("command"))
            if name == "?" { XCTAssertTrue(key.modifiers.contains("shift")) }
        }
    }
    func testInvalidKeyAndModifierAreRejectedBeforePosting() {
        for (name, modifiers, expected) in [("Cmd+L", [String](), "key_unsupported"), ("l", ["banana"], "modifier_unsupported")] {
            do { _ = try namedKey(name, modifiers: modifiers); XCTFail("Must reject") }
            catch let error as HelperError { XCTAssertEqual(error.code, expected); XCTAssertEqual(error.phase, "rejected-before-dispatch") }
            catch { XCTFail("Unexpected error") }
        }
    }
    func testFallbackNeverInventsAnIdentityForIdenticalTitlesAndFrames() {
        let bounds = UIBounds(x: 0, y: 0, w: 300, h: 200)
        let candidates = [WindowCandidate(windowId: 2, title: "same", bounds: bounds), WindowCandidate(windowId: 1, title: "same", bounds: bounds)]
        XCTAssertEqual(matchingWindowIDs(title: "same", bounds: bounds.rect, candidates: candidates), [2, 1])
        XCTAssertEqual(matchingWindowIDs(title: "distinct", bounds: bounds.rect, candidates: candidates), [])
    }
}
