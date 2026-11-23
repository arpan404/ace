import CoreGraphics
import Testing
@testable import Ace

struct PixelGridTests {
    @Test func aHeightRoundsUpToAWholePixel() {
        #expect(PixelGrid.ceil(97.67, scale: 3) == 98)
        #expect(PixelGrid.ceil(97.1, scale: 2) == 97.5)
    }

    @Test func aHeightOnThePixelGridStaysWhereItIs() {
        #expect(PixelGrid.ceil(98, scale: 3) == 98)
        #expect(PixelGrid.ceil(54.5, scale: 2) == 54.5)
    }

    @Test func aMissingScaleLeavesTheHeightAlone() {
        #expect(PixelGrid.ceil(97.67, scale: 0) == 97.67)
    }
}
