import CoreGraphics
import Testing
@testable import Ace

/// Where the full-screen viewer puts an image at rest.
@Suite struct MediaFitTests {
    private let phone = CGSize(width: 402, height: 874)

    @Test func aSmallImageGrowsToTheScreensWidthKeepingItsShape() {
        let fitted = MediaFit.fitted(CGSize(width: 120, height: 80), in: phone)
        #expect(abs(fitted.width - 402) < 0.01)
        #expect(abs(fitted.height - 268) < 0.01)
    }

    @Test func aLargeTallImageShrinksToTheScreensHeight() {
        let fitted = MediaFit.fitted(CGSize(width: 3000, height: 9000), in: phone)
        #expect(abs(fitted.height - 874) < 0.01)
        #expect(fitted.width <= 402)
    }

    @Test func anImageWithoutASizeTakesNoSpace() {
        #expect(MediaFit.fitted(.zero, in: phone) == .zero)
    }
}
