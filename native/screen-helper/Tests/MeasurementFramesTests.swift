import XCTest
import CoreGraphics
@testable import ScreenHelper

final class MeasurementFramesTests: XCTestCase {
    func testAVisualResponseProducesDamageAndIgnoresSmallNoise() {
        let before = MeasurementPixels(width: 4, height: 4, rgb: [UInt8](repeating: 0, count: 48))
        let noise = MeasurementPixels(width: 4, height: 4, rgb: [UInt8](repeating: 5, count: 48))
        XCTAssertNil(noise.difference(from: before))
        var changed = before.rgb
        changed[15] = 200
        let response = MeasurementPixels(width: 4, height: 4, rgb: changed)
        XCTAssertEqual(response.difference(from: before), CGRect(x: 0.25, y: 0.25, width: 0.25, height: 0.25))
        XCTAssertTrue(response.changed(near: CGPoint(x: 0.25, y: 0.25), from: before))
        XCTAssertFalse(response.changed(near: CGPoint(x: 0.9, y: 0.9), from: before))
    }
    func testFilmstripKeepsWorstHitchEndpointsAndFinalResponseWithinEightTiles() throws {
        let space = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        var strip = MeasurementCandidates()
        for at in [0.0, 16, 32, 48, 64, 80, 200, 216, 232, 248, 264, 280, 296, 312, 328, 344, 360, 376, 392, 408, 424, 440, 456, 472, 488, 504, 520, 536, 552, 568, 584, 600] {
            strip.receive(MeasurementCandidate(atMs: at, image: image, damage: nil), intervalMs: 1000 / 60, windowMs: 1000)
        }
        let selected = strip.selected()
        XCTAssertLessThanOrEqual(selected.count, 8)
        XCTAssertEqual(selected.first?.atMs, 0)
        XCTAssertEqual(selected.last?.atMs, 600)
        XCTAssertTrue(selected.contains { $0.atMs == 80 && $0.hitch })
        XCTAssertTrue(selected.contains { $0.atMs == 200 && $0.hitch })
    }
    func testSettledImageSurvivesThreeWorstHitchesWithinEightTiles() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        var strip = MeasurementCandidates()
        for at in [0.0, 16, 32, 150, 166, 282, 298, 410, 426, 442, 458, 474, 490, 506, 522, 538, 554, 570, 586, 602] {
            strip.receive(MeasurementCandidate(atMs: at, image: image, damage: nil), intervalMs: 1000 / 60, windowMs: 1000)
        }
        let selected = strip.selected()
        XCTAssertLessThanOrEqual(selected.count, 8)
        XCTAssertEqual(selected.first?.atMs, 0)
        XCTAssertEqual(selected.last?.atMs, 602)
        XCTAssertTrue(selected.contains { $0.atMs == 32 && $0.hitch })
        XCTAssertTrue(selected.contains { $0.atMs == 150 && $0.hitch })
    }
    func testQuietSettlingGapDoesNotReceiveAHitchMarker() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        var strip = MeasurementCandidates()
        for at in [0.0, 8.33, 16.67, 400] { strip.receive(MeasurementCandidate(atMs: at, image: image, damage: nil), intervalMs: 1000 / 120, windowMs: 1000) }
        XCTAssertFalse(strip.selected().contains { $0.hitch })
    }
}
