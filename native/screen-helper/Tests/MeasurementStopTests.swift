import XCTest
import Foundation
@testable import ScreenHelper

final class MeasurementStopTests: XCTestCase {
    func testASuccessfulCaptureStopAcknowledgementCanBeAwaitedAgain() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let stop = MeasurementStop(stopCapture: {
            // A second physical stop would fail this real edge rather than acknowledge twice.
            try Data("capture stopped".utf8).write(to: path, options: .withoutOverwriting)
        }, failed: { _ in })
        try await stop.stop()
        try await stop.stop()
        XCTAssertEqual(try String(contentsOf: path, encoding: .utf8), "capture stopped")
    }
    func testAnUnacknowledgedCaptureStopTriggersFailureAndNeverReturnsSuccess() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let stop = MeasurementStop(stopCapture: {
            throw NSError(domain: "capture-stop", code: 37)
        }, failed: { _ in try? Data("capture state unknown".utf8).write(to: path) })
        for _ in 0..<2 {
            do { try await stop.stop(); XCTFail("An unacknowledged capture stop returned success") }
            catch { XCTAssertEqual((error as NSError).domain, "capture-stop") }
        }
        XCTAssertEqual(try String(contentsOf: path, encoding: .utf8), "capture state unknown")
    }
}
