import CoreGraphics
import Testing
@testable import Ace

/// The accent ink a finger leaves on the live page while drawing (`AnnotateStroke.ink`): it shows
/// the circle or underline as drawn, before the page's own marker takes over.
@Suite struct AnnotateInkTests {
    @Test func aTapLeavesNoInk() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: CGPoint(x: 10, y: 10), page: CGPoint(x: 20, y: 20), fingers: 1)
        _ = stroke.moved(view: CGPoint(x: 12, y: 11), page: CGPoint(x: 24, y: 22))
        _ = stroke.ended()
        #expect(stroke.ink.isEmpty)
    }

    @Test func aDragInksTheWayTheFingerWentFromWhereItStarted() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: CGPoint(x: 0, y: 0), page: .zero, fingers: 1)
        _ = stroke.moved(view: CGPoint(x: 30, y: 0), page: CGPoint(x: 60, y: 0))
        _ = stroke.moved(view: CGPoint(x: 30, y: 30), page: CGPoint(x: 60, y: 60))
        #expect(stroke.ink == [CGPoint(x: 0, y: 0), CGPoint(x: 30, y: 0), CGPoint(x: 30, y: 30)])
        // The finished drawing stays inked until the next touch begins.
        _ = stroke.ended()
        #expect(stroke.ink.count == 3)
        _ = stroke.began(view: CGPoint(x: 5, y: 5), page: .zero, fingers: 1)
        #expect(stroke.ink.isEmpty)
    }

    @Test func aSecondFingerWipesTheInkBecauseItScrollsInstead() {
        var stroke = AnnotateStroke()
        _ = stroke.began(view: .zero, page: .zero, fingers: 1)
        _ = stroke.moved(view: CGPoint(x: 40, y: 0), page: CGPoint(x: 80, y: 0))
        #expect(!stroke.ink.isEmpty)
        _ = stroke.began(view: CGPoint(x: 90, y: 0), page: .zero, fingers: 2)
        #expect(stroke.ink.isEmpty)
        _ = stroke.moved(view: CGPoint(x: 0, y: 90), page: .zero)
        #expect(stroke.ink.isEmpty)
    }
}
