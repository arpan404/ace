import CoreGraphics
import Foundation
import Testing
@testable import Ace

/// A device picture is turned upright, fitted into the view, and a finger maps back through the
/// same turn to picture pixels, then to device points by the picture's scale.
@Suite struct DeviceViewportTests {
    @Test func anUnrotatedPictureIsLetterboxedAndTouchesMapThroughItsScale() throws {
        let viewport = DeviceViewport(width: 200, height: 400, scale: 2, rotation: .none, viewSize: CGSize(width: 300, height: 400))
        #expect(viewport.frame == CGRect(x: 50, y: 0, width: 200, height: 400))
        #expect(close(viewport.devicePoint(at: CGPoint(x: 150, y: 200)), CGPoint(x: 50, y: 100)))
        // The bars beside the picture aren't the device.
        #expect(viewport.devicePoint(at: CGPoint(x: 20, y: 200)) == nil)
    }

    @Test func aQuarterTurnStandsThePictureUprightAndTouchesFindTheTurnedPixel() throws {
        // A 100 × 200 picture turned 90° clockwise is 200 × 100 upright, centred in 400 × 100.
        let viewport = DeviceViewport(width: 100, height: 200, scale: 2, rotation: .quarter, viewSize: CGSize(width: 400, height: 100))
        #expect(viewport.uprightSize == CGSize(width: 200, height: 100))
        #expect(viewport.frame == CGRect(x: 100, y: 0, width: 200, height: 100))
        // The picture's top-left corner is drawn at the upright picture's top-right.
        #expect(CGPoint.zero.applying(viewport.transform) == CGPoint(x: 300, y: 0))
        #expect(close(viewport.picturePixel(at: CGPoint(x: 300, y: 0)), .zero))
        #expect(close(viewport.devicePoint(at: CGPoint(x: 101, y: 99)), CGPoint(x: 49.5, y: 99.5)))
        #expect(viewport.devicePoint(at: CGPoint(x: 50, y: 50)) == nil)
    }

    @Test func halfAndThreeQuarterTurnsMapCornersToTheOppositeSides() throws {
        let half = DeviceViewport(width: 100, height: 200, scale: 1, rotation: .half, viewSize: CGSize(width: 100, height: 200))
        #expect(close(half.picturePixel(at: CGPoint(x: 10, y: 20)), CGPoint(x: 90, y: 180)))

        let threeQuarters = DeviceViewport(width: 100, height: 200, scale: 1, rotation: .threeQuarters, viewSize: CGSize(width: 200, height: 100))
        // The picture's top-left is the upright view's bottom-left; the view's top-right is the
        // picture's bottom-right.
        #expect(close(threeQuarters.picturePixel(at: CGPoint(x: 0, y: 100)), .zero))
        #expect(close(threeQuarters.picturePixel(at: CGPoint(x: 200, y: 0)), CGPoint(x: 100, y: 200)))
    }

    @Test func theViewportFollowsTheFramesHeader() throws {
        let frame = DeviceFrameChunk(deviceId: "android:emulator-5554", streamId: "cap", sequence: 0, timestamp: 0,
                                     width: 1080, height: 2400, scale: 2.5, rotation: .none, codec: "jpeg", key: true, bytes: Data([1]))
        let viewport = DeviceViewport(frame, viewSize: CGSize(width: 432, height: 960))
        #expect(close(viewport.devicePoint(at: CGPoint(x: 432, y: 960)), CGPoint(x: 432, y: 960)))
    }

    private func close(_ point: CGPoint?, _ expected: CGPoint) -> Bool {
        guard let point else { return false }
        return abs(point.x - expected.x) < 1e-9 && abs(point.y - expected.y) < 1e-9
    }
}
