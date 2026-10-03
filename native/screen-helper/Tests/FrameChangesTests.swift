import XCTest
import CoreGraphics
import ScreenHelper

final class FrameChangesTests: XCTestCase {
    func testOnlyDamageOrAnExplicitSnapshotProducesFrames() {
        var source = FrameChanges()
        XCTAssertTrue(source.changed(initial: true, dirtyRects: [], fingerprint: { nil }))
        for _ in 0..<100 { XCTAssertFalse(source.changed(initial: false, dirtyRects: [], fingerprint: { nil })) }
        XCTAssertTrue(source.changed(initial: false, dirtyRects: [CGRect(x: 0, y: 0, width: 1, height: 1)], fingerprint: { nil }))
        XCTAssertFalse(source.changed(initial: false, dirtyRects: [], fingerprint: { nil }))
        XCTAssertTrue(source.changed(initial: true, dirtyRects: [], fingerprint: { nil }))
    }
    func testMissingDamageUsesContentChangesAndUnavailableHashesCannotHideChanges() {
        var source = FrameChanges()
        XCTAssertTrue(source.changed(initial: false, dirtyRects: nil, fingerprint: { 10 }))
        XCTAssertFalse(source.changed(initial: false, dirtyRects: nil, fingerprint: { 10 }))
        XCTAssertTrue(source.changed(initial: false, dirtyRects: nil, fingerprint: { 11 }))
        XCTAssertFalse(source.changed(initial: false, dirtyRects: nil, fingerprint: { 11 }))
        XCTAssertTrue(source.changed(initial: false, dirtyRects: nil, fingerprint: { nil }))
    }
}
